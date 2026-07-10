/**
 * Resilient MCP entrypoint for Codex and other stdio hosts.
 *
 * One launcher owns the bridge port and supervises main.js. Other launchers
 * attach to that owner over the local Streamable HTTP handoff. Startup is
 * coordinated with a short-lived cross-process lock, stale locks are removed
 * safely, messages are buffered until the proxy is ready, and a disconnected
 * proxy can take ownership after the old owner exits.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "../infrastructure/config/load-config.js";

const SERVICE = "executor-mcp-roblox";
const LAUNCHER_VERSION = "2.1.0";
const DEFAULT_PROBE_TIMEOUT_MS = 700;
const DEFAULT_READY_TIMEOUT_MS = 15000;
const DEFAULT_MAX_START_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 2500;

interface Health {
  service?: unknown;
  status?: unknown;
  version?: unknown;
  connectedClients?: unknown;
}

interface OwnerProbe {
  readonly kind: "ready";
  readonly base: string;
  readonly health: Health;
}

interface IncompatibleOwner {
  readonly kind: "incompatible";
  readonly reason: string;
}

type ProbeResult = OwnerProbe | IncompatibleOwner | undefined;

interface LockMetadata {
  readonly pid: number;
  readonly startedAt: number;
  readonly host: string;
  readonly port: number;
  readonly launcher: string;
}

interface StartupLock {
  readonly path: string;
  readonly handle: FileHandle;
}

interface RuntimeOptions {
  readonly probeTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly maxStartAttempts: number;
  readonly retryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly debug: boolean;
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.floor(parsed) : fallback;
}

function runtimeOptions(): RuntimeOptions {
  return {
    probeTimeoutMs: envNumber(
      "ROBLOX_MCP_LAUNCHER_PROBE_TIMEOUT_MS",
      DEFAULT_PROBE_TIMEOUT_MS,
      100,
      10000,
    ),
    readyTimeoutMs: envNumber(
      "ROBLOX_MCP_LAUNCHER_READY_TIMEOUT_MS",
      DEFAULT_READY_TIMEOUT_MS,
      1000,
      120000,
    ),
    maxStartAttempts: envNumber(
      "ROBLOX_MCP_LAUNCHER_MAX_START_ATTEMPTS",
      DEFAULT_MAX_START_ATTEMPTS,
      1,
      20,
    ),
    retryDelayMs: envNumber(
      "ROBLOX_MCP_LAUNCHER_RETRY_DELAY_MS",
      DEFAULT_RETRY_DELAY_MS,
      25,
      10000,
    ),
    maxRetryDelayMs: envNumber(
      "ROBLOX_MCP_LAUNCHER_MAX_RETRY_DELAY_MS",
      DEFAULT_MAX_RETRY_DELAY_MS,
      25,
      30000,
    ),
    debug: ["1", "true", "yes", "on"].includes(
      process.env["ROBLOX_MCP_LAUNCHER_DEBUG"]?.trim().toLowerCase() ?? "",
    ),
  };
}

function log(message: string, debug = false): void {
  if (debug && !runtimeOptions().debug) return;
  process.stderr.write(`executor-mcp-roblox launcher: ${message}\n`);
}

function probeHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function endpoint(host: string, port: number): string {
  return `http://${probeHost(host)}:${port}`;
}

function lockPath(host: string, port: number): string {
  const safeHost = probeHost(host).replace(/[^a-zA-Z0-9.-]/g, "_");
  // Keep the lock in a user-owned location instead of the repository so a
  // package install, working-directory change, or read-only repo cannot break
  // multi-launcher coordination.
  const base = process.env["ROBLOX_MCP_RUNTIME_DIR"]?.trim() || join(homedir(), ".executor-mcp");
  return join(base, `launcher-${safeHost}-${port}.lock`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function findOwner(host: string, port: number, probeTimeoutMs: number): Promise<ProbeResult> {
  const base = endpoint(host, port);
  try {
    const response = await fetchWithTimeout(`${base}/api/health`, probeTimeoutMs, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const health = (await response.json()) as Health;
    if (health.service !== SERVICE || health.status !== "ok") return undefined;

    // A pre-supervisor direct-main process can look healthy but cannot accept
    // proxy sessions. Report it distinctly so the operator gets a useful
    // restart instruction instead of a vague EADDRINUSE loop.
    const mcpProbe = await fetchWithTimeout(`${base}/mcp`, probeTimeoutMs, {
      headers: { accept: "application/json, text/event-stream" },
    });
    await mcpProbe.body?.cancel().catch(() => undefined);
    if (mcpProbe.status === 404) {
      return {
        kind: "incompatible",
        reason: `an older server owns ${host}:${port}; restart that server once so the launcher handoff can be enabled`,
      };
    }
    return { kind: "ready", base, health };
  } catch {
    return undefined;
  }
}

async function waitForOwner(
  host: string,
  port: number,
  options: RuntimeOptions,
  timeoutMs: number,
): Promise<OwnerProbe | IncompatibleOwner | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const owner = await findOwner(host, port, options.probeTimeoutMs);
    if (owner) return owner;
    await sleep(Math.min(100, Math.max(10, deadline - Date.now())));
  }
  return undefined;
}

async function acquireStartupLock(
  path: string,
  host: string,
  port: number,
  debug: boolean,
): Promise<StartupLock | undefined> {
  await mkdir(dirname(path), { recursive: true });
  for (let pass = 0; pass < 2; pass += 1) {
    const metadata: LockMetadata = {
      pid: process.pid,
      startedAt: Date.now(),
      host,
      port,
      launcher: LAUNCHER_VERSION,
    };
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify(metadata));
      log(`startup lock acquired for ${host}:${port}`, debug);
      return { path, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    try {
      const raw = await readFile(path, "utf8");
      const existing = JSON.parse(raw) as Partial<LockMetadata>;
      if (typeof existing.pid === "number" && isProcessAlive(existing.pid)) return undefined;
      await unlink(path).catch(() => undefined);
      log(`removed stale startup lock ${path}`, debug);
    } catch {
      // A competing launcher may be writing or removing the lock. The caller
      // will retry after a short delay and re-check the owner endpoint.
      return undefined;
    }
  }
  return undefined;
}

async function releaseStartupLock(lock: StartupLock, debug: boolean): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  await unlink(lock.path).catch(() => undefined);
  log("startup lock released", debug);
}

async function proxyToOwner(base: string, debug: boolean): Promise<boolean> {
  const stdio = new StdioServerTransport();
  const http = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
    },
  });

  let closed = false;
  let inputClosed = false;
  let upstreamReady = false;
  let resolveClosed: (() => void) | undefined;
  const queued: Parameters<NonNullable<typeof stdio.onmessage>>[0][] = [];
  const finished = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const finish = (): void => {
    if (closed) return;
    closed = true;
    resolveClosed?.();
  };
  const fail = (error: unknown): void => {
    if (closed) return;
    const message = error instanceof Error ? error.message : String(error);
    log(`owner connection lost - ${message}`);
    finish();
  };
  const closeFromInput = (): void => {
    inputClosed = true;
    finish();
  };
  const sendUpstream = (message: (typeof queued)[number]): void => {
    void http.send(message).catch(fail);
  };

  stdio.onmessage = (message) => {
    if (upstreamReady) sendUpstream(message);
    else queued.push(message);
  };
  http.onmessage = (message) => {
    void stdio.send(message).catch(fail);
  };
  stdio.onerror = fail;
  http.onerror = fail;
  stdio.onclose = () => {
    void http.close().catch(fail);
    finish();
  };
  http.onclose = () => {
    if (!closed) fail(new Error("HTTP transport closed"));
  };
  process.stdin.once("end", closeFromInput);
  process.stdin.once("close", closeFromInput);

  try {
    await stdio.start();
    await http.start();
    upstreamReady = true;
    for (const message of queued.splice(0)) sendUpstream(message);
    log(`proxy attached to ${base}`, debug);
    await finished;
  } finally {
    process.stdin.off("end", closeFromInput);
    process.stdin.off("close", closeFromInput);
    await stdio.close().catch(() => undefined);
    await http.close().catch(() => undefined);
  }
  return !inputClosed;
}

async function exitCode(child: ChildProcess): Promise<number> {
  try {
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    return code ?? (signal ? 1 : 0);
  } catch {
    return 1;
  }
}

async function startOwner(
  argv: string[],
  host: string,
  port: number,
  options: RuntimeOptions,
): Promise<number> {
  const mainPath = join(dirname(fileURLToPath(import.meta.url)), "main.js");
  const child = spawn(process.execPath, [mainPath, ...argv], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const result = await Promise.race([
    waitForOwner(host, port, options, options.readyTimeoutMs).then((owner) => ({ owner })),
    exitCode(child).then((code) => ({ code })),
  ]);
  if ("code" in result) return result.code;
  if (result.owner?.kind !== "ready") {
    if (result.owner?.kind === "incompatible") log(result.owner.reason);
    child.kill();
    return 1;
  }
  log(`owner ready on ${host}:${port}`, options.debug);
  return exitCode(child);
}

function retryDelay(attempt: number, options: RuntimeOptions): number {
  return Math.min(options.maxRetryDelayMs, options.retryDelayMs * 2 ** Math.max(0, attempt - 1));
}

function hostInputClosed(): boolean {
  return process.stdin.readableEnded || process.stdin.destroyed;
}

async function run(argv: string[]): Promise<void> {
  const config = loadConfig(argv, process.env);
  const options = runtimeOptions();
  const { host, port } = config.server;
  const path = lockPath(host, port);
  let lastExitCode = 1;

  for (let attempt = 1; attempt <= options.maxStartAttempts; attempt += 1) {
    const owner = await findOwner(host, port, options.probeTimeoutMs);
    if (owner?.kind === "incompatible") throw new Error(owner.reason);
    if (owner?.kind === "ready") {
      const retry = await proxyToOwner(owner.base, options.debug);
      if (!retry) return;
      await sleep(retryDelay(attempt, options));
      continue;
    }

    const lock = await acquireStartupLock(path, host, port, options.debug);
    if (!lock) {
      const winner = await waitForOwner(host, port, options, options.readyTimeoutMs);
      if (winner?.kind === "incompatible") throw new Error(winner.reason);
      if (winner?.kind === "ready") continue;
      await sleep(retryDelay(attempt, options));
      continue;
    }

    try {
      lastExitCode = await startOwner(argv, host, port, options);
    } finally {
      await releaseStartupLock(lock, options.debug);
    }

    // A simultaneous launcher may have won the bind while this child was
    // starting. Give that owner a chance to appear before retrying the spawn.
    const winner = await waitForOwner(host, port, options, 1500);
    if (winner?.kind === "incompatible") throw new Error(winner.reason);
    if (winner?.kind === "ready") continue;
    if (lastExitCode === 0 && hostInputClosed()) return;
    if (attempt < options.maxStartAttempts) {
      log(
        `owner exited with code ${lastExitCode}; restarting while the host transport is alive (${attempt}/${options.maxStartAttempts})`,
      );
      await sleep(retryDelay(attempt, options));
    }
  }

  throw new Error(
    `could not start or attach to ${SERVICE} on ${host}:${port} after ${options.maxStartAttempts} attempts (last exit code ${lastExitCode})`,
  );
}

void run(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`executor-mcp-roblox launcher: ${message}\n`);
  process.exitCode = 1;
});
