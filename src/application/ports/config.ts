import type { SessionId } from "../../domain/shared/ids.js";
import type { LogLevel } from "./logger.js";

/**
 * The fully-resolved, validated application configuration. Produced once at
 * startup by the config adapter (env + CLI flags) and injected read-only
 * everywhere. No code reads `process.env` directly.
 */
export interface AppConfig {
  readonly server: {
    /** Bind address. Loopback by default; `0.0.0.0` only for trusted networks. */
    readonly host: string;
    /** Bridge + dashboard port. */
    readonly port: number;
  };
  readonly session: {
    readonly id: SessionId;
    readonly label: string;
  };
  readonly logging: {
    readonly level: LogLevel;
    /** Pretty-print logs (dev) vs. JSON lines (prod). */
    readonly pretty: boolean;
  };
  readonly execution: {
    readonly defaultTimeoutMs: number;
    readonly defaultThreadContext: number;
    /** Extra allow-listed roots for host filesystem reads (execute-file), beyond cwd + ~/Documents. */
    readonly scriptDirs: readonly string[];
  };
  readonly semantic: {
    /** Embeddings HTTP endpoint (Ollama/OpenAI-compatible). Null = local fallback embedding. */
    readonly embeddingsUrl: string | null;
    readonly embeddingsModel: string;
  };
  readonly bridge: {
    readonly heartbeatIntervalMs: number;
  };
  readonly dashboard: {
    readonly enabled: boolean;
  };
}
