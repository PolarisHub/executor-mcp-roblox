/**
 * A live feed of everything a client's game prints. The connector taps
 * `LogService.MessageOut` (which captures every print/warn/error in the game,
 * including from `script`-tool runs) and streams batches over the bridge's
 * `event` channel; the transport records them here. The dashboard's Output
 * console and the `get-output` tool read from it.
 */

/** Classifies a line of game output, mirroring Roblox's `Enum.MessageType`. */
export type OutputKind = "print" | "info" | "warn" | "error" | "system";

/** Where a line originated: `game` = LogService capture, `script` = a script-tool run. */
export type OutputSource = "game" | "script";

export interface OutputEntry {
  readonly clientId: string;
  readonly clientName: string | null;
  readonly kind: OutputKind;
  readonly message: string;
  /** Epoch millis when the line was produced in-game (server clock if absent). */
  readonly at: number;
  /** Where this line came from. Defaults to "game" for entries without an explicit source. */
  readonly source: OutputSource;
  /** When source === "script", the per-run token of the script that emitted this line. */
  readonly scriptToken?: string | null;
}

export interface OutputLog {
  /** Append one line of output. */
  record(entry: OutputEntry): void;
  /** Newest-first lines, optionally filtered to one client. */
  recent(limit: number, clientId?: string): readonly OutputEntry[];
  /** Drop buffered lines (all, or just one client's). */
  clear(clientId?: string): void;
}
