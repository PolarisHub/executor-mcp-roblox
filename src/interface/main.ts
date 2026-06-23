/**
 * Composition root. This is the ONLY place that knows about concrete adapters:
 * it loads config, instantiates the infrastructure, wires it to the application
 * ports, registers the tools, and starts the transports. Everything else depends
 * on interfaces, so this file is the single seam where the system is assembled.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolRegistry } from "../application/tool/registry.js";
import { ScriptBridge } from "../application/services/script-bridge.js";
import { SessionManager } from "../application/services/session-manager.js";
import { ToolInvoker } from "../application/services/tool-invoker.js";
import { loadConfig } from "../infrastructure/config/load-config.js";
import { ChildProcessShell } from "../infrastructure/host/child-process-shell.js";
import { SandboxedHostFileSystem } from "../infrastructure/host/sandboxed-file-system.js";
import { Dashboard } from "../infrastructure/dashboard/dashboard.js";
import { DashboardEventBus } from "../infrastructure/dashboard/dashboard-events.js";
import { DashboardWebSocketServer } from "../infrastructure/dashboard/dashboard-ws.js";
import { McpAdapter } from "../infrastructure/mcp/mcp-adapter.js";
import { HealthReporter } from "../infrastructure/observability/health.js";
import { InMemoryActivityLog } from "../infrastructure/observability/in-memory-activity-log.js";
import { InMemoryOutputLog } from "../infrastructure/observability/in-memory-output-log.js";
import { createLogger } from "../infrastructure/observability/pino-logger.js";
import { createMetrics } from "../infrastructure/observability/metrics.js";
import { systemClock } from "../infrastructure/observability/system-clock.js";
import { InMemorySessionStore } from "../infrastructure/persistence/in-memory-session-store.js";
import { CachedEmbeddingsProvider } from "../infrastructure/semantic/cached-embeddings-provider.js";
import { HttpEmbeddingsProvider } from "../infrastructure/semantic/http-embeddings-provider.js";
import { InMemorySemanticIndex } from "../infrastructure/semantic/in-memory-semantic-index.js";
import { FsSavedScriptsStore } from "../infrastructure/playbooks/fs-saved-scripts.js";
import { FsSessionLogger } from "../infrastructure/sessions/fs-session-logger.js";
import { BridgeServer } from "../infrastructure/transport/bridge-server.js";
import { allTools } from "../tools/index.js";

const APP_VERSION = "2.0.0";

interface Application {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Assemble the whole system from configuration. Pure wiring — no side effects yet. */
function compose(): Application {
  const config = loadConfig(process.argv.slice(2), process.env);
  const logger = createLogger(config.logging).child({ session: config.session.id });
  const clock = systemClock;
  const metrics = createMetrics();

  const sessionStore = new InMemorySessionStore();
  // Live feed of every client's in-game output (print/warn/error), streamed by
  // the connector over the bridge `event` channel.
  const output = new InMemoryOutputLog();
  // BridgeServer is both the ExecutionGateway and the ClientDirectory, so the
  // same instance is injected wherever either port is required.
  const bridge = new BridgeServer({ config, logger, clock, metrics, output });
  const health = new HealthReporter({ clock, clients: bridge, version: APP_VERSION });

  // Serve the in-game connector so the loader can fetch it over HTTP. Resolved
  // relative to this module so it works from `dist/` and from a published package.
  const connectorPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../connector/connector.luau",
  );
  bridge.addRoutes((app) => {
    app.get("/api/health", (c) => c.json(health.report()));
    app.get("/connector.luau", (c) => {
      try {
        return c.body(readFileSync(connectorPath, "utf8"), 200, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      } catch {
        return c.text("connector.luau not found", 404);
      }
    });
  });

  // Host-side capabilities (server machine): a sandboxed filesystem (execute-file)
  // and an OS shell (Windows tools). The filesystem is allow-listed to the cwd,
  // ~/Documents, and any configured script dirs.
  const host = {
    shell: new ChildProcessShell({ logger }),
    fs: new SandboxedHostFileSystem([
      process.cwd(),
      join(homedir(), "Documents"),
      ...config.execution.scriptDirs,
    ]),
  };
  // Wrap the configured embeddings provider with an on-disk sha256-keyed cache
  // (~/.executor-mcp/embeddings.json) so a place's script bodies only have to
  // be embedded once across server restarts.
  const semantic = new InMemorySemanticIndex({
    embeddings: new CachedEmbeddingsProvider(new HttpEmbeddingsProvider(config.semantic)),
  });

  const sessions = new SessionManager(sessionStore, bridge);
  const registry = new ToolRegistry();
  registry.registerAll(allTools());
  const activity = new InMemoryActivityLog();
  // Backs the `script` tool's in-game `mcp.<tool>()` bridge.
  const scriptBridge = new ScriptBridge();
  // Filesystem-backed playbook store (~/.executor-mcp/playbooks/).
  const playbooks = new FsSavedScriptsStore();
  // Filesystem-backed per-session trace (~/.executor-mcp/sessions/<id>.jsonl).
  const sessionLogger = new FsSessionLogger();

  // Shared event bus + WS push channel for live dashboard updates. Subscribers
  // get output/activity/client-change events as JSON frames over /ws/dashboard.
  const eventBus = new DashboardEventBus();
  if (output instanceof InMemoryOutputLog) {
    output.setOnRecord((entry) => eventBus.emitOutput([entry]));
  }
  if (activity instanceof InMemoryActivityLog) {
    activity.setOnRecord((record) => eventBus.emitActivity(record));
  }
  bridge.setOnClientChange((action, clientId) => eventBus.emitClientChange(action, clientId));
  if (config.dashboard.enabled) {
    const ws = new DashboardWebSocketServer({ logger, bus: eventBus });
    bridge.addUpgrade("/ws/dashboard", (req, sock, head) => ws.handleUpgrade(req, sock, head));
  }

  // The dashboard (when enabled) claims `/` and the `/api/*` read endpoints.
  if (config.dashboard.enabled) {
    const dashboard = new Dashboard({
      config,
      clients: bridge,
      registry,
      activity,
      health,
      gateway: bridge,
      output,
      admin: bridge,
      playbooks,
      scriptBridge,
    });
    bridge.addRoutes((app) => dashboard.mount(app));
  } else {
    bridge.addRoutes((app) => app.get("/", (c) => c.text("executor-mcp-roblox")));
  }

  const invoker = new ToolInvoker({
    registry,
    sessions,
    gateway: bridge,
    clients: bridge,
    logger,
    metrics,
    clock,
    config,
    host,
    semantic,
    activity,
    scriptBridge,
    playbooks,
    sessionLogger,
  });
  scriptBridge.attach(invoker);
  bridge.attachScripting(scriptBridge);

  // Legacy fallback: the old HTTP path is kept for older connectors that don't
  // know about the WebSocket-native `rpc-call` frames. New connectors route every
  // `mcp.<tool>()` over the WebSocket instead, removing the executor `request()`
  // dependency from the hot path entirely.
  bridge.addRoutes((app) => {
    app.post("/api/exec-tool", async (c) => {
      let payload: { token?: unknown; tool?: unknown; args?: unknown };
      try {
        payload = (await c.req.json());
      } catch {
        return c.json({ ok: false, error: "invalid JSON body" }, 400);
      }
      const token = typeof payload.token === "string" ? payload.token : "";
      const tool = typeof payload.tool === "string" ? payload.tool : "";
      // Roblox encodes an empty Lua table as `[]`; treat that as "no args".
      const args = Array.isArray(payload.args) && payload.args.length === 0 ? {} : payload.args;
      if (!token || !tool) return c.json({ ok: false, error: "missing token or tool" }, 400);
      return c.json(await scriptBridge.run(token, tool, args));
    });
  });

  const mcp = new McpAdapter({ registry, invoker, config, logger, activity });

  // Pre-create this process's session so its label shows up immediately.
  sessionStore.getOrCreate(config.session.id, config.session.label);

  let stopping = false;
  return {
    async start() {
      await bridge.start();
      await mcp.connectStdio();
      if (!config.bridge.authToken) {
        logger.warn(
          "bridge running WITHOUT an auth token — any local process can drive the game. " +
            "Set ROBLOX_MCP_BRIDGE_TOKEN to a random string and pass `getgenv().BridgeToken` " +
            "in the loader to require a matching token on every connect.",
        );
      }
      logger.info(
        {
          version: APP_VERSION,
          host: config.server.host,
          port: config.server.port,
          tools: registry.size,
          label: config.session.label,
          auth: config.bridge.authToken ? "token" : "open",
        },
        "executor-mcp-roblox ready",
      );
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      logger.info("shutting down");
      await bridge.stop();
    },
  };
}

async function main(): Promise<void> {
  let app: Application;
  try {
    app = compose();
  } catch (error) {
    // Logger may not exist yet; stderr is safe (stdout is reserved for MCP).
    process.stderr.write(`fatal: failed to start — ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    void app
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await app.start();
}

void main();
