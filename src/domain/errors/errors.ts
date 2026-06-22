/**
 * Domain error hierarchy. Every failure that crosses a layer boundary is one of
 * these typed errors, so the interface layer can map them to stable, predictable
 * responses (an MCP error, an HTTP status) without leaking stack traces or
 * stringly-typed guesswork. Infrastructure exceptions are wrapped before they
 * escape their adapter.
 */

/** Stable, machine-readable failure codes (mirrored in the API docs). */
export type ErrorCode =
  | "VALIDATION"
  | "TOOL_NOT_FOUND"
  | "NO_CLIENT_SELECTED"
  | "AMBIGUOUS_CLIENT"
  | "CLIENT_NOT_FOUND"
  | "CLIENT_DISCONNECTED"
  | "EXECUTION_FAILED"
  | "EXECUTION_TIMEOUT"
  | "PROTOCOL"
  | "CONFIG"
  | "INTERNAL";

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  /** True when the caller could plausibly succeed by changing their input/state. */
  readonly retryable: boolean = false;

  constructor(
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }

  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: { ...this.details } } : {}),
    };
  }
}

/** Input failed schema validation. */
export class ValidationError extends DomainError {
  readonly code = "VALIDATION" as const;
}

/** No tool is registered under the requested name. */
export class ToolNotFoundError extends DomainError {
  readonly code = "TOOL_NOT_FOUND" as const;
  constructor(toolName: string) {
    super(`No tool named "${toolName}" is registered.`, { toolName });
  }
}

/** A session that owns no client tried to run a client-bound tool. */
export class NoClientSelectedError extends DomainError {
  readonly code = "NO_CLIENT_SELECTED" as const;
}

/** Several distinct accounts are connected and the session has not chosen one. */
export class AmbiguousClientError extends DomainError {
  readonly code = "AMBIGUOUS_CLIENT" as const;
}

/** The selected/targeted client id is not (or no longer) connected. */
export class ClientNotFoundError extends DomainError {
  readonly code = "CLIENT_NOT_FOUND" as const;
}

/** The client's connection dropped while a request was in flight. */
export class ClientDisconnectedError extends DomainError {
  readonly code = "CLIENT_DISCONNECTED" as const;
  override readonly retryable = true;
}

/** The connector reported a runtime error while executing the request. */
export class ExecutionFailedError extends DomainError {
  readonly code = "EXECUTION_FAILED" as const;
}

/** The connector did not answer within the deadline. */
export class ExecutionTimeoutError extends DomainError {
  readonly code = "EXECUTION_TIMEOUT" as const;
  override readonly retryable = true;
}

/** A malformed or unexpected protocol message was received. */
export class ProtocolError extends DomainError {
  readonly code = "PROTOCOL" as const;
}

/** Server configuration is invalid. */
export class ConfigError extends DomainError {
  readonly code = "CONFIG" as const;
}

/** Unexpected internal failure (a bug). Wrap unknown throwables in this. */
export class InternalError extends DomainError {
  readonly code = "INTERNAL" as const;
}

/** Coerce any thrown value into a DomainError, preserving the cause. */
export function toDomainError(thrown: unknown): DomainError {
  if (thrown instanceof DomainError) return thrown;
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return new InternalError(message, undefined, { cause: thrown });
}
