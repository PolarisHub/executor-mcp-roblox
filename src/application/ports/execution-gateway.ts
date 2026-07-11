import type { ClientId } from "../../domain/shared/ids.js";

export type EvalPriority = "normal" | "nested";

export interface EvalRequest {
  /** Luau source to execute on the client. The first returned value comes back decoded. */
  readonly source: string;
  /** Roblox thread identity (defaults applied by the gateway from config). */
  readonly threadContext?: number;
  /** Per-call deadline override (defaults applied by the gateway from config). */
  readonly timeoutMs?: number;
  /** "vm" runs in the persistent VM env; "vm-reset" wipes it; omitted = fresh. */
  readonly env?: "fresh" | "vm" | "vm-reset";
  /** Per-run token that gates inbound `rpc-call` frames from this script's mcp.* calls. */
  readonly scriptToken?: string;
  /** Nested script RPCs use the reserved lane so a parent script cannot deadlock itself. */
  readonly priority?: EvalPriority;
  /** Host-only fairness key. It is never sent to or exposed inside the game. */
  readonly schedulerKey?: string;
}

/**
 * Port for running code on a specific connected client. The transport adapter
 * implements it by sending a protocol `op` and awaiting the matching `result`.
 * Tools never touch this directly — they go through the {@link ToolContext},
 * which binds it to the already-resolved active client.
 */
export interface ExecutionGateway {
  eval(clientId: ClientId, request: EvalRequest, signal?: AbortSignal): Promise<unknown>;
}
