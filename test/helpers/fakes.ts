import type { RobloxClient } from "../../src/domain/client/client.js";
import { createSession, type Session } from "../../src/domain/client/session.js";
import { ClientId, UserId } from "../../src/domain/shared/ids.js";
import type { ClientId as ClientIdType, SessionId } from "../../src/domain/shared/ids.js";
import type { ClientDirectory } from "../../src/application/ports/client-directory.js";
import type { Clock } from "../../src/application/ports/clock.js";
import type { Logger } from "../../src/application/ports/logger.js";
import type { Metrics } from "../../src/application/ports/metrics.js";
import type { SessionStore } from "../../src/application/ports/session-store.js";

/** A Logger that does nothing, including its child() chain. Useful as a default in tests. */
export function silentLogger(): Logger {
  const logger: Logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => logger,
  };
  return logger;
}

/**
 * A deterministic clock. `now()` and `monotonic()` both start at `start` and only
 * move when `advance(ms)` is called, so duration assertions are exact.
 */
export function fakeClock(start = 0): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    monotonic: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A Metrics port that records nothing. */
export function noopMetrics(): Metrics {
  return {
    increment: () => {},
    observe: () => {},
    gauge: () => {},
  };
}

let clientSeq = 0;

/**
 * Build a RobloxClient with sensible defaults. Every call gets a fresh, unique
 * clientId unless one is supplied, so two `makeClient()` calls are distinct
 * connections by default. Pass `userId`/`username` to control account identity.
 */
export function makeClient(partial: Partial<RobloxClient> = {}): RobloxClient {
  const seq = ++clientSeq;
  const base: RobloxClient = {
    id: ClientId(`client-${seq}`),
    userId: UserId(1000 + seq),
    username: `player${seq}`,
    displayName: `Player ${seq}`,
    placeId: 123456,
    jobId: `job-${seq}`,
    executor: "TestExecutor",
    capabilities: ["getgc", "hookfunction"],
    connectedAt: seq,
  };
  return { ...base, ...partial };
}

/** A ClientDirectory backed by a fixed array (ordered as given). */
export class InMemoryClientDirectory implements ClientDirectory {
  private readonly clients: readonly RobloxClient[];

  constructor(clients: readonly RobloxClient[] = []) {
    this.clients = clients;
  }

  list(): readonly RobloxClient[] {
    return this.clients;
  }

  get(clientId: ClientIdType): RobloxClient | undefined {
    return this.clients.find((c) => c.id === clientId);
  }
}

/** A process-scoped SessionStore for tests, mirroring the default in-memory adapter. */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<SessionId, Session>();

  get(sessionId: SessionId): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getOrCreate(sessionId: SessionId, label: string): Session {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created = createSession(sessionId, label);
    this.sessions.set(sessionId, created);
    return created;
  }

  save(session: Session): void {
    this.sessions.set(session.id, session);
  }

  list(): readonly Session[] {
    return [...this.sessions.values()];
  }
}
