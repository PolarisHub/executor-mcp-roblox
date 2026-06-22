export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Structured logger port (pino-compatible surface). Adapters bind it to a real
 * logger; tests bind it to a no-op or a spy. Pass a context object as the first
 * argument and a message as the second: `logger.info({ toolName }, "invoked")`.
 */
export interface Logger {
  trace(obj: Record<string, unknown>, msg?: string): void;
  trace(msg: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  debug(msg: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
  fatal(obj: Record<string, unknown>, msg?: string): void;
  fatal(msg: string): void;
  /** Derive a child logger that always includes `bindings`. */
  child(bindings: Record<string, unknown>): Logger;
}
