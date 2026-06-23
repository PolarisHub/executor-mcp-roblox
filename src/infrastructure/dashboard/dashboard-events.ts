import { EventEmitter } from "node:events";

import type { ActivityRecord } from "../../application/ports/activity-log.js";
import type { OutputEntry } from "../../application/ports/output-log.js";

/**
 * In-process event bus that the dashboard's WebSocket adapter subscribes to.
 *
 * Sources (ActivityLog, OutputLog, BridgeServer) call `emit*` when state
 * changes; subscribers receive typed payloads and forward them to connected
 * dashboard clients as JSON frames. Coalescing/throttling is the subscriber's
 * responsibility — the bus itself is fire-and-forget.
 */
export type DashboardEvent =
  | { readonly type: "output"; readonly entries: readonly OutputEntry[] }
  | { readonly type: "activity"; readonly record: ActivityRecord }
  | { readonly type: "client-change"; readonly action: "connect" | "disconnect"; readonly clientId: string };

export class DashboardEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Per-event-name listener cap is plenty for the dashboard fan-out; the
    // default of 10 fires a warning we don't need.
    this.emitter.setMaxListeners(64);
  }

  emitOutput(entries: readonly OutputEntry[]): void {
    if (entries.length === 0) return;
    this.emitter.emit("dashboard", { type: "output", entries });
  }

  emitActivity(record: ActivityRecord): void {
    this.emitter.emit("dashboard", { type: "activity", record });
  }

  emitClientChange(action: "connect" | "disconnect", clientId: string): void {
    this.emitter.emit("dashboard", { type: "client-change", action, clientId });
  }

  subscribe(listener: (event: DashboardEvent) => void): () => void {
    this.emitter.on("dashboard", listener);
    return () => this.emitter.off("dashboard", listener);
  }
}
