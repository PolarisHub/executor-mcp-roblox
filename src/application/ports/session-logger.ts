/**
 * Append-only per-session trace of every tool invocation. Lets operators
 * (and the AI) audit what was actually run, dry-run a replay before re-issuing,
 * or extract a script trace as a reusable playbook. Stored as JSONL — one
 * record per line — for human readability + greppability.
 */
export interface SessionTraceRecord {
  /** Monotonically increasing within a session, starting at 1. */
  readonly seq: number;
  /** Epoch millis when the call completed (success or failure). */
  readonly at: number;
  readonly tool: string;
  readonly input: unknown;
  /** Present iff the call returned ok. */
  readonly result?: unknown;
  /** Present iff the call failed. */
  readonly error?: { readonly message: string; readonly code?: string };
  /** Wall-time spent inside the invoker (validate + execute + bookkeeping). */
  readonly elapsedMs: number;
  /** The resolved client at call time, if the tool required one. */
  readonly clientId?: string;
  /** The session UUID; lets multi-session writers share one writer. */
  readonly sessionId: string;
}

export interface SessionTraceSummary {
  readonly sessionId: string;
  readonly sessionLabel: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly count: number;
  readonly bytes: number;
}

export interface SessionLogger {
  /** Append one record. Best-effort: a write failure must NOT bubble into the invoker. */
  append(record: SessionTraceRecord, sessionLabel: string): void;
  /** Enumerate every recorded session (newest-first by startedAt). */
  list(): Promise<readonly SessionTraceSummary[]>;
  /** Read a window of records from one session (default: all). */
  read(sessionId: string, opts?: { from?: number; to?: number }): Promise<readonly SessionTraceRecord[]>;
}
