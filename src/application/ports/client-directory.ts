import type { RobloxClient } from "../../domain/client/client.js";
import type { ClientId } from "../../domain/shared/ids.js";

export interface ClientBridgeLoad {
  readonly clientId: ClientId;
  readonly activeEvals: number;
  readonly queuedEvals: number;
  readonly queuedSourceBytes: number;
  readonly activeScriptParents: number;
  readonly queuedNestedEvals: number;
  readonly queuedAgents: number;
  readonly activeRpcFrames: number;
  readonly queuedRpcFrames: number;
  readonly rejectedEvals: number;
  readonly oldestQueuedMs: number;
  readonly limits: {
    readonly concurrentEvals: number;
    readonly queuedEvals: number;
    readonly queuedSourceBytes: number;
    readonly concurrentRpcFrames: number;
    readonly queuedRpcFrames: number;
  };
}

export interface BridgeLoadSnapshot {
  readonly activeEvals: number;
  readonly queuedEvals: number;
  readonly queuedSourceBytes: number;
  readonly activeRpcFrames: number;
  readonly queuedRpcFrames: number;
  readonly rejectedEvals: number;
  readonly saturatedClients: number;
  readonly clients: readonly ClientBridgeLoad[];
}

/**
 * Read model of the currently-connected clients, published by the transport.
 * Application services query it; they never mutate the live socket set.
 */
export interface ClientDirectory {
  list(): readonly RobloxClient[];
  get(clientId: ClientId): RobloxClient | undefined;
  /** Optional transport load view. Read-only fakes/directories may omit it. */
  loadSnapshot?(): BridgeLoadSnapshot;
}
