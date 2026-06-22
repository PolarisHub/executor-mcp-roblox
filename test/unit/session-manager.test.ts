import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/application/services/session-manager.js";
import { AmbiguousClientError, NoClientSelectedError } from "../../src/domain/errors/errors.js";
import { ClientId, SessionId, UserId } from "../../src/domain/shared/ids.js";
import { InMemoryClientDirectory, InMemorySessionStore, makeClient } from "../helpers/fakes.js";

const SID = SessionId("session-1");
const LABEL = "Test Session";

describe("SessionManager", () => {
  it("persists a selection and exposes it via getOrCreate", () => {
    const store = new InMemorySessionStore();
    const directory = new InMemoryClientDirectory([]);
    const manager = new SessionManager(store, directory);

    manager.select(SID, LABEL, { username: "alice" });

    expect(manager.getOrCreate(SID, LABEL).selection).toEqual({ username: "alice" });
    // The store itself was written, not just an ephemeral copy.
    expect(store.get(SID)?.selection).toEqual({ username: "alice" });
  });

  it("clears a previously persisted selection", () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store, new InMemoryClientDirectory([]));

    manager.select(SID, LABEL, { userId: UserId(5) });
    manager.clear(SID, LABEL);

    expect(manager.getOrCreate(SID, LABEL).selection).toEqual({});
  });

  it("requireActiveClient returns the resolved client", () => {
    const client = makeClient({ userId: UserId(1), username: "solo" });
    const manager = new SessionManager(
      new InMemorySessionStore(),
      new InMemoryClientDirectory([client]),
    );

    expect(manager.requireActiveClient(SID, LABEL)).toBe(client);
  });

  it("requireActiveClient throws NoClientSelectedError (NO_CLIENT_SELECTED) with no clients", () => {
    const manager = new SessionManager(new InMemorySessionStore(), new InMemoryClientDirectory([]));

    try {
      manager.requireActiveClient(SID, LABEL);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoClientSelectedError);
      expect((err as NoClientSelectedError).code).toBe("NO_CLIENT_SELECTED");
      expect((err as NoClientSelectedError).details).toMatchObject({ reason: "no-clients" });
    }
  });

  it("requireActiveClient throws NoClientSelectedError when the pinned client is offline", () => {
    const present = makeClient({ userId: UserId(1), username: "alice" });
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store, new InMemoryClientDirectory([present]));
    manager.select(SID, LABEL, { username: "ghost" });

    try {
      manager.requireActiveClient(SID, LABEL);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoClientSelectedError);
      expect((err as NoClientSelectedError).details).toMatchObject({
        reason: "selection-offline",
      });
    }
  });

  it("requireActiveClient throws AmbiguousClientError (AMBIGUOUS_CLIENT) on multiple accounts", () => {
    const a = makeClient({ id: ClientId("a"), userId: UserId(1), username: "alice" });
    const b = makeClient({ id: ClientId("b"), userId: UserId(2), username: "bob" });
    const manager = new SessionManager(
      new InMemorySessionStore(),
      new InMemoryClientDirectory([a, b]),
    );

    try {
      manager.requireActiveClient(SID, LABEL);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousClientError);
      expect((err as AmbiguousClientError).code).toBe("AMBIGUOUS_CLIENT");
      const details = (err as AmbiguousClientError).details as {
        candidates: Array<{ clientId: string; username: string | null }>;
      };
      expect(details.candidates).toHaveLength(2);
      expect(details.candidates).toEqual(
        expect.arrayContaining([
          { clientId: "a", username: "alice" },
          { clientId: "b", username: "bob" },
        ]),
      );
    }
  });

  it("createContext round-trips the persisted selection and lets a tool mutate it", () => {
    const store = new InMemorySessionStore();
    const client = makeClient({ userId: UserId(7), username: "neo" });
    const manager = new SessionManager(store, new InMemoryClientDirectory([client]));

    manager.select(SID, LABEL, { userId: UserId(7) });
    const ctx = manager.createContext(SID, LABEL);

    expect(ctx.id).toBe(SID);
    expect(ctx.label).toBe(LABEL);
    expect(ctx.selection).toEqual({ userId: UserId(7) });

    const resolved = ctx.resolve();
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") expect(resolved.client).toBe(client);

    // select() through the context writes back to the store.
    ctx.select({ username: "neo" });
    expect(store.get(SID)?.selection).toEqual({ username: "neo" });

    // clear() through the context wipes it.
    ctx.clear();
    expect(store.get(SID)?.selection).toEqual({});
  });

  it("isolates two sessions so one selection never clobbers the other", () => {
    const a = makeClient({ id: ClientId("a"), userId: UserId(1), username: "alice" });
    const b = makeClient({ id: ClientId("b"), userId: UserId(2), username: "bob" });
    const manager = new SessionManager(
      new InMemorySessionStore(),
      new InMemoryClientDirectory([a, b]),
    );
    const s1 = SessionId("s1");
    const s2 = SessionId("s2");

    manager.select(s1, "one", { userId: UserId(1) });
    manager.select(s2, "two", { userId: UserId(2) });

    expect(manager.requireActiveClient(s1, "one")).toBe(a);
    expect(manager.requireActiveClient(s2, "two")).toBe(b);
  });
});
