import type {
  ActivityLog,
  ActivityRecord,
  ActivitySummary,
  ToolStats,
} from "../../application/ports/activity-log.js";

/**
 * Bounded in-memory activity feed: a ring buffer of the most recent records plus
 * lifetime counters. Cheap and allocation-stable; the dashboard polls `recent`.
 */
export class InMemoryActivityLog implements ActivityLog {
  private readonly buffer: ActivityRecord[] = [];
  private total = 0;
  private errors = 0;
  /** Per-tool lifetime counters (runs, errors). Unbounded by ring capacity. */
  private readonly perTool = new Map<string, { runs: number; errors: number }>();

  constructor(private readonly capacity = 250) {}

  record(record: ActivityRecord): void {
    this.total += 1;
    if (record.outcome === "error") this.errors += 1;
    this.buffer.push(record);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    const stats = this.perTool.get(record.toolName) ?? { runs: 0, errors: 0 };
    stats.runs += 1;
    if (record.outcome === "error") stats.errors += 1;
    this.perTool.set(record.toolName, stats);
  }

  recent(limit: number): readonly ActivityRecord[] {
    const n = Math.max(0, Math.min(limit, this.buffer.length));
    return this.buffer.slice(this.buffer.length - n).reverse();
  }

  summary(): ActivitySummary {
    return { total: this.total, errors: this.errors };
  }

  perToolStats(): readonly ToolStats[] {
    const out: ToolStats[] = [];
    for (const [tool, s] of this.perTool) out.push({ tool, runs: s.runs, errors: s.errors });
    return out;
  }
}
