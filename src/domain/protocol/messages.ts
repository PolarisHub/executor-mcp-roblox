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
  /**
   * Optional shared-secret auth token. When the server has bridge.authToken set
   * (via ROBLOX_MCP_BRIDGE_TOKEN env), this must match exactly or the connection
   * is closed. When unset on the server side, this field is ignored.
   */
  readonly token?: string | null;
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
  /**
   * When present, the connector pre-binds a built-in `mcp` table in the run env
   * that routes calls back to the server as `rpc-call` frames (gated by this
   * token). Print/warn are also captured and returned in `{ result, output }`.
   * The token is minted server-side per-run and only the script's env sees it.
   */
  readonly scriptToken?: string;
}

/** The outcome of a {@link ClientOp}. */
export type OpResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly kind?: "timeout" | "runtime" };

/** Outcome of an `rpc-call` (tool invocation made from inside a running script). */
export type RpcResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: string; readonly code?: string };

/** One call inside an `rpc-batch` frame; results come back keyed by `key`. */
export interface RpcBatchCall {
  readonly key: string;
  readonly tool: string;
  readonly args: unknown;
}
export type RpcBatchResultEntry = RpcResult & { readonly key: string };

/** Server -> connector. */
export type ServerMessage =
  | {
      readonly type: "welcome";
      readonly serverVersion: string;
      readonly heartbeatIntervalMs: number;
    }
  | { readonly type: "op"; readonly id: string; readonly op: ClientOp }
  | { readonly type: "ping"; readonly id: string }
  | { readonly type: "rpc-result"; readonly id: string; readonly result: RpcResult }
  | { readonly type: "rpc-batch-result"; readonly id: string; readonly results: readonly RpcBatchResultEntry[] };

/** Connector -> server. */
export type ClientMessage =
  | { readonly type: "hello"; readonly protocolVersion: number; readonly client: ClientHandshake }
  | { readonly type: "result"; readonly id: string; readonly result: OpResult }
  | { readonly type: "event"; readonly channel: string; readonly data: unknown }
  | { readonly type: "pong"; readonly id: string }
  | {
      /** A running script invoked `mcp.<tool>(args)`. The server runs the tool and replies `rpc-result`. */
      readonly type: "rpc-call";
      readonly id: string;
      readonly token: string;
      readonly tool: string;
      readonly args: unknown;
    }
  | {
      /** A running script invoked `mcp.all({...})`. Each call runs in parallel; one `rpc-batch-result` returns. */
      readonly type: "rpc-batch";
      readonly id: string;
      readonly token: string;
      readonly calls: readonly RpcBatchCall[];
    };
