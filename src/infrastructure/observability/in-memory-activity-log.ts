import type {
  ActivityLog,
  ActivityRecord,
  ActivitySummary,
} from "../../application/ports/activity-log.js";

/**
 * Bounded in-memory activity feed: a ring buffer of the most recent records plus
 * lifetime counters. Cheap and allocation-stable; the dashboard polls `recent`.
 */
export class InMemoryActivityLog implements ActivityLog {
  private readonly buffer: ActivityRecord[] = [];
  private total = 0;
  private errors = 0;

  constructor(private readonly capacity = 250) {}

  record(record: ActivityRecord): void {
    this.total += 1;
    if (record.outcome === "error") this.errors += 1;
    this.buffer.push(record);
    if (this.buffer.length > this.capacity) this.buffer.shift();
  }

  recent(limit: number): readonly ActivityRecord[] {
    const n = Math.max(0, Math.min(limit, this.buffer.length));
    return this.buffer.slice(this.buffer.length - n).reverse();
  }

  summary(): ActivitySummary {
    return { total: this.total, errors: this.errors };
  }
}
