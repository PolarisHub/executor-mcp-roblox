/**
 * The bridge wire protocol (server <-> in-game connector). This is a clean-slate
 * redesign: a small, explicit, versioned, JSON message envelope. Both sides speak
 * these exact shapes; the connector serializes results as JSON (no bespoke Lua
 * encoding), which keeps the contract symmetric and debuggable.
 *
 * These are pure data shapes. Runtime validation (zod) lives in the transport
 * adapter so the domain stays dependency-free.
 */

/** Bump on any breaking change to the envelope. The connector sends its version in `hello`. */
export const PROTOCOL_VERSION = 1;

/** Identity + capabilities a connector advertises when it connects. */
export interface ClientHandshake {
  readonly clientId: string;
  readonly userId: number | null;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly placeId: number | null;
  readonly jobId: string | null;
  readonly executor: string | null;
  /** Executor functions the connector probed as available (e.g. "getgc", "hookfunction"). */
  readonly capabilities: readonly string[];
}

/** A unit of work the server asks the connector to perform. */
export interface ClientOp {
  readonly kind: "eval";
  /** Luau source. The connector runs it and returns the first returned value. */
  readonly source: string;
  /** Thread identity to run under (Roblox: 2 = game scripts, 8 = elevated). */
  readonly threadContext: number;
  /** Hard deadline; the connector aborts and reports a timeout past this. */
  readonly timeoutMs: number;
  /**
   * Where to run. Omitted/"fresh" = a one-shot chunk in a clean environment.
   * "vm" = the persistent, hidden VM environment whose globals survive across
   * runs (a REPL-like session). "vm-reset" wipes that environment and returns.
   * The connector falls back to a fresh env if it cannot sandbox.
   */
  readonly env?: "fresh" | "vm" | "vm-reset";
}

/** The outcome of a {@link ClientOp}. */
export type OpResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly kind?: "timeout" | "runtime" };

/** Server -> connector. */
export type ServerMessage =
  | {
      readonly type: "welcome";
      readonly serverVersion: string;
      readonly heartbeatIntervalMs: number;
    }
  | { readonly type: "op"; readonly id: string; readonly op: ClientOp }
  | { readonly type: "ping"; readonly id: string };

/** Connector -> server. */
export type ClientMessage =
  | { readonly type: "hello"; readonly protocolVersion: number; readonly client: ClientHandshake }
  | { readonly type: "result"; readonly id: string; readonly result: OpResult }
  | { readonly type: "event"; readonly channel: string; readonly data: unknown }
  | { readonly type: "pong"; readonly id: string };
