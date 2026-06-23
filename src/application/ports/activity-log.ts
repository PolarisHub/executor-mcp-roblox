import type { RobloxClient } from "../../domain/client/client.js";
import type { ToolCategory } from "../../domain/tool/category.js";
import type { ClientId, SessionId } from "../../domain/shared/ids.js";

/** One recorded tool invocation, for the live activity feed. */
export interface ActivityRecord {
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly sessionId: SessionId;
  readonly clientId?: ClientId;
  readonly clientName?: RobloxClient["username"];
  readonly outcome: "ok" | "error";
  readonly durationMs: number;
  readonly errorCode?: string;
  /** Epoch millis. */
  readonly at: number;
}

export interface ActivitySummary {
  readonly total: number;
  readonly errors: number;
}

/** Lifetime per-tool counters used by `suggest-tools` and similar discovery aids. */
export interface ToolStats {
  readonly tool: string;
  readonly runs: number;
  readonly errors: number;
}

/**
 * Append-only feed of recent tool invocations, kept for the dashboard. The
 * {@link ToolInvoker} records every call; the dashboard reads the tail.
 */
export interface ActivityLog {
  record(record: ActivityRecord): void;
  /** Most recent records, newest first, capped at `limit`. */
  recent(limit: number): readonly ActivityRecord[];
  /** Lifetime totals (not bounded by the ring buffer). */
  summary(): ActivitySummary;
  /** Per-tool lifetime counters; used to rank tools by past success. */
  perToolStats(): readonly ToolStats[];
}
