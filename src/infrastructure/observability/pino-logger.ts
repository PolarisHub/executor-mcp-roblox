import pino from "pino";
import type { Logger as PinoLogger, LoggerOptions } from "pino";
import type { AppConfig } from "../../application/ports/config.js";
import type { Logger } from "../../application/ports/logger.js";

/**
 * Adapt a pino instance to the {@link Logger} port. pino's call signatures already
 * match the port's `(obj, msg?)` / `(msg)` overloads, so the wrapper mainly exists
 * to (a) narrow the surface to exactly the port and (b) keep `child()` returning a
 * wrapped logger rather than a raw pino instance.
 */
class PinoLoggerAdapter implements Logger {
  constructor(private readonly pino: PinoLogger) {}

  trace(obj: Record<string, unknown> | string, msg?: string): void {
    this.log("trace", obj, msg);
  }

  debug(obj: Record<string, unknown> | string, msg?: string): void {
    this.log("debug", obj, msg);
  }

  info(obj: Record<string, unknown> | string, msg?: string): void {
    this.log("info", obj, msg);
  }

  warn(obj: Record<string, unknown> | string, msg?: string): void {
    this.log("warn", obj, msg);
  }

  error(obj: Record<string, unknown> | string, msg?: string): void {
    this.log("error", obj, msg);
  }

  fatal(obj: Record<string, unknown> | string, msg?: string): void {
    this.log("fatal", obj, msg);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new PinoLoggerAdapter(this.pino.child(bindings));
  }

  private log(
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal",
    obj: Record<string, unknown> | string,
    msg?: string,
  ): void {
    if (typeof obj === "string") {
      this.pino[level](obj);
    } else {
      this.pino[level](obj, msg);
    }
  }
}

/**
 * Create a {@link Logger} backed by pino. CRITICAL: all output goes to STDERR
 * (fd 2) so STDOUT stays exclusively reserved for the MCP stdio protocol. When
 * `pretty` is enabled the pino-pretty transport is used (also writing to stderr).
 */
export function createLogger(options: AppConfig["logging"]): Logger {
  const base: LoggerOptions = { level: options.level };

  if (options.pretty) {
    const instance = pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: {
          destination: 2,
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
    });
    return new PinoLoggerAdapter(instance);
  }

  const instance = pino(base, pino.destination(2));
  return new PinoLoggerAdapter(instance);
}
