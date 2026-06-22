import type { Session } from "../../domain/client/session.js";
import type { SessionId } from "../../domain/shared/ids.js";

/**
 * Persistence port for session selection state. The default adapter is in-memory
 * (selection is process-scoped), but the interface allows a durable store later
 * without touching the application layer.
 */
export interface SessionStore {
  get(sessionId: SessionId): Session | undefined;
  getOrCreate(sessionId: SessionId, label: string): Session;
  save(session: Session): void;
  list(): readonly Session[];
}
