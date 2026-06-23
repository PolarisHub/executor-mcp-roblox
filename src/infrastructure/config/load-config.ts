import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ConfigError } from "../../domain/errors/errors.js";
import { SessionId } from "../../domain/shared/ids.js";
import type { AppConfig } from "../../application/ports/config.js";
import type { LogLevel } from "../../application/ports/logger.js";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 16384,
  logLevel: "info" as LogLevel,
  pretty: false,
  defaultTimeoutMs: 30000,
  defaultThreadContext: 8,
  heartbeatIntervalMs: 2000,
  dashboardEnabled: true,
  embeddingsModel: "embeddinggemma",
} as const;

const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

const configSchema = z.object({
  host: z.string().trim().min(1, "host must not be empty"),
  port: z
    .number()
    .int("port must be an integer")
    .min(1, "port must be between 1 and 65535")
    .max(65535, "port must be between 1 and 65535"),
  level: z.enum(LOG_LEVELS as [LogLevel, ...LogLevel[]]),
  pretty: z.boolean(),
  sessionLabel: z.string().trim().min(1).optional(),
  dashboardEnabled: z.boolean(),
});

/**
 * Parsed CLI flags. Unknown flags are ignored so that wrappers (the MCP host)
 * can pass through their own arguments without breaking startup.
 */
interface CliFlags {
  host?: string;
  port?: string;
  sessionLabel?: string;
  noDashboard?: boolean;
}

function parseArgv(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    const eq = arg.indexOf("=");
    const [name, inlineValue] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];

    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        i += 1;
        return next;
      }
      return undefined;
    };

    switch (name) {
      case "--port":
        flags.port = takeValue();
        break;
      case "--host":
        flags.host = takeValue();
        break;
      case "--session-label":
        flags.sessionLabel = takeValue();
        break;
      case "--no-dashboard":
        flags.noDashboard = true;
        break;
      default:
        break;
    }
  }
  return flags;
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError(`Invalid port "${raw}": expected a positive integer.`, {
      port: raw,
    });
  }
  return Number.parseInt(trimmed, 10);
}

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

/**
 * Build the fully-resolved {@link AppConfig} from CLI flags and environment
 * variables. CLI flags take precedence over env, which takes precedence over the
 * built-in defaults. Throws {@link ConfigError} when the result is invalid.
 */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): AppConfig {
  const cli = parseArgv(argv);

  const cliPort = parsePort(cli.port);
  const envPort = parsePort(env["ROBLOX_MCP_PORT"]);

  const host = cli.host?.trim() || env["ROBLOX_MCP_HOST"]?.trim() || DEFAULTS.host;
  const port = cliPort ?? envPort ?? DEFAULTS.port;
  const level = (env["ROBLOX_MCP_LOG_LEVEL"]?.trim() || DEFAULTS.logLevel) as LogLevel;
  const pretty = parseBoolEnv(env["ROBLOX_MCP_LOG_PRETTY"]) ?? DEFAULTS.pretty;
  const sessionLabel =
    cli.sessionLabel?.trim() || env["ROBLOX_MCP_SESSION_LABEL"]?.trim() || undefined;
  const dashboardEnabled = cli.noDashboard ? false : DEFAULTS.dashboardEnabled;

  const parsed = configSchema.safeParse({
    host,
    port,
    level,
    pretty,
    sessionLabel,
    dashboardEnabled,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue
      ? `Invalid configuration: ${issue.path.join(".") || "value"}: ${issue.message}`
      : "Invalid configuration.";
    throw new ConfigError(message, {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const value = parsed.data;
  const id = randomUUID();
  const label = value.sessionLabel ?? `session-${shortId(id)}`;

  const scriptDirs = (env["ROBLOX_MCP_SCRIPT_DIRS"]?.trim() ?? "")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const embeddingsUrl = env["ROBLOX_MCP_EMBEDDINGS_URL"]?.trim() || null;
  const embeddingsModel = env["ROBLOX_MCP_EMBEDDINGS_MODEL"]?.trim() || DEFAULTS.embeddingsModel;
  const authToken = env["ROBLOX_MCP_BRIDGE_TOKEN"]?.trim() || null;

  return {
    server: {
      host: value.host,
      port: value.port,
    },
    session: {
      id: SessionId(id),
      label,
    },
    logging: {
      level: value.level,
      pretty: value.pretty,
    },
    execution: {
      defaultTimeoutMs: DEFAULTS.defaultTimeoutMs,
      defaultThreadContext: DEFAULTS.defaultThreadContext,
      scriptDirs,
    },
    semantic: {
      embeddingsUrl,
      embeddingsModel,
    },
    bridge: {
      heartbeatIntervalMs: DEFAULTS.heartbeatIntervalMs,
      authToken,
    },
    dashboard: {
      enabled: value.dashboardEnabled,
    },
  };
}
