import type { OutputEntry, OutputLog } from "../../application/ports/output-log.js";

/**
 * Fixed-capacity ring buffer of recent game output across all clients. Old lines
 * are overwritten once the buffer is full, so memory is bounded no matter how
 * chatty a game is. `recent()` returns newest-first.
 */
export class InMemoryOutputLog implements OutputLog {
  private readonly buffer: OutputEntry[];
  private readonly capacity: number;
  private head = 0;
  private size = 0;
  /** Optional sink called after every record (used by the live dashboard WS). */
  private onRecord: ((entry: OutputEntry) => void) | null = null;

  constructor(capacity = 4000) {
    this.capacity = Math.max(1, capacity);
    this.buffer = new Array<OutputEntry>(this.capacity);
  }

  /** Subscribe to records as they happen. Pass null to unsubscribe. */
  setOnRecord(fn: ((entry: OutputEntry) => void) | null): void {
    this.onRecord = fn;
  }

  record(entry: OutputEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
    if (this.onRecord) this.onRecord(entry);
  }

  recent(limit: number, clientId?: string): readonly OutputEntry[] {
    const out: OutputEntry[] = [];
    for (let i = 1; i <= this.size && out.length < limit; i++) {
      const idx = (this.head - i + this.capacity) % this.capacity;
      const entry = this.buffer[idx];
      if (!entry) continue;
      if (clientId && entry.clientId !== clientId) continue;
      out.push(entry);
    }
    return out;
  }

  clear(clientId?: string): void {
    if (!clientId) {
      this.head = 0;
      this.size = 0;
      this.buffer.length = 0;
      this.buffer.length = this.capacity;
      return;
    }
    // Compact out one client's lines, keeping order for the rest.
    const kept = this.recent(this.capacity).filter((e) => e.clientId !== clientId);
    this.head = 0;
    this.size = 0;
    this.buffer.length = 0;
    this.buffer.length = this.capacity;
    for (let i = kept.length - 1; i >= 0; i--) {
      const entry = kept[i];
      if (entry) this.record(entry);
    }
  }
}
