import { createSession } from "../../domain/client/session.js";
import type { Session } from "../../domain/client/session.js";
import type { SessionId } from "../../domain/shared/ids.js";
import type { SessionStore } from "../../application/ports/session-store.js";

/**
 * Process-scoped {@link SessionStore}. Selection state lives only as long as the
 * server process; restarting the server forgets every session's selection. A
 * durable store can replace this without touching the application layer.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<SessionId, Session>();

  get(sessionId: SessionId): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getOrCreate(sessionId: SessionId, label: string): Session {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = createSession(sessionId, label);
    this.sessions.set(sessionId, session);
    return session;
  }

  save(session: Session): void {
    this.sessions.set(session.id, session);
  }

  list(): readonly Session[] {
    return [...this.sessions.values()];
  }
}
