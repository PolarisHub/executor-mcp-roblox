import type { SessionId } from "../shared/ids.js";
import type { ClientSelection } from "./selection.js";

/**
 * One AI session driving the bridge. Each session keeps its own selection, so two
 * sessions can target two different games without ever clobbering each other.
 */
export interface Session {
  readonly id: SessionId;
  /** Human-readable label shown in diagnostics/dashboard. */
  readonly label: string;
  readonly selection: ClientSelection;
}

export function createSession(id: SessionId, label: string): Session {
  return { id, label, selection: {} };
}

export function withSelection(session: Session, selection: ClientSelection): Session {
  return { ...session, selection };
}

export function clearSelection(session: Session): Session {
  return { ...session, selection: {} };
}
