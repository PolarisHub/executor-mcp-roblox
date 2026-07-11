import { describe, expect, it } from "vitest";
import { resolveSelection } from "../../src/domain/client/selection.js";
import type { ClientSelection } from "../../src/domain/client/selection.js";
import { ClientId, UserId } from "../../src/domain/shared/ids.js";
import { makeClient } from "../helpers/fakes.js";

describe("resolveSelection", () => {
  it("returns none/no-clients when nothing is connected", () => {
    const result = resolveSelection({}, []);
    expect(result).toEqual({ status: "none", reason: "no-clients" });
  });

  it("auto-resolves the single connected client when there is no selection", () => {
    const only = makeClient();
    const result = resolveSelection({}, [only]);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.client).toBe(only);
  });

  it("is ambiguous when two distinct accounts are connected with no selection", () => {
    const a = makeClient({ userId: UserId(1), username: "alice" });
    const b = makeClient({ userId: UserId(2), username: "bob" });
    const result = resolveSelection({}, [a, b]);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates).toEqual(expect.arrayContaining([a, b]));
    }
  });

  it("resolves an exact clientId hit", () => {
    const a = makeClient({ id: ClientId("conn-a"), userId: UserId(1), username: "alice" });
    const b = makeClient({ id: ClientId("conn-b"), userId: UserId(2), username: "bob" });
    const selection: ClientSelection = { clientId: ClientId("conn-b") };
    const result = resolveSelection(selection, [a, b]);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.client).toBe(b);
  });

  it("sticks to an account by username (case-insensitive) across a new clientId", () => {
    // The original connection (Alice on conn-old) is gone; she reconnected under conn-new.
    const reconnected = makeClient({
      id: ClientId("conn-new"),
      userId: UserId(1),
      username: "Alice",
    });
    const other = makeClient({ id: ClientId("conn-x"), userId: UserId(2), username: "bob" });
    const selection: ClientSelection = { username: "alice" };
    const result = resolveSelection(selection, [other, reconnected]);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.client).toBe(reconnected);
  });

  it("sticks to an account by userId across a new clientId", () => {
    const reconnected = makeClient({
      id: ClientId("conn-new"),
      userId: UserId(42),
      username: "neo",
    });
    const other = makeClient({ id: ClientId("conn-x"), userId: UserId(7), username: "trinity" });
    const selection: ClientSelection = { userId: UserId(42) };
    const result = resolveSelection(selection, [other, reconnected]);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.client).toBe(reconnected);
  });

  it("recovers a pinned clientId that reconnected under the same account", () => {
    // Pinned conn-old is gone, but the same account is online under conn-new.
    const reconnected = makeClient({
      id: ClientId("conn-new"),
      userId: UserId(99),
      username: "morpheus",
    });
    const selection: ClientSelection = { clientId: ClientId("conn-old"), userId: UserId(99) };
    const result = resolveSelection(selection, [reconnected]);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.client).toBe(reconnected);
  });

  it("returns none/selection-offline when a pinned account is offline", () => {
    const present = makeClient({ userId: UserId(1), username: "alice" });
    const selection: ClientSelection = { userId: UserId(2), username: "bob" };
    const result = resolveSelection(selection, [present]);
    expect(result).toEqual({ status: "none", reason: "selection-offline" });
  });

  it("recovers a clientId-only pin whose socket reconnected under a new id", () => {
    // A clientId-only pin has no account to protect. If the pinned connection is
    // gone (e.g. it reconnected under a fresh id) and exactly one client is online,
    // resolve to it instead of reporting the client offline.
    const present = makeClient({ id: ClientId("conn-here"), userId: UserId(1) });
    const selection: ClientSelection = { clientId: ClientId("conn-missing") };
    const result = resolveSelection(selection, [present]);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.client).toBe(present);
  });

  it("is ambiguous (never cross-switches) when a clientId-only pin is gone and accounts differ", () => {
    const a = makeClient({ id: ClientId("conn-a"), userId: UserId(1), username: "alice" });
    const b = makeClient({ id: ClientId("conn-b"), userId: UserId(2), username: "bob" });
    const selection: ClientSelection = { clientId: ClientId("conn-missing") };
    const result = resolveSelection(selection, [a, b]);
    expect(result.status).toBe("ambiguous");
  });

  it("picks the newest socket when the same account is on two connections", () => {
    const older = makeClient({
      id: ClientId("conn-old"),
      userId: UserId(5),
      username: "smith",
      connectedAt: 100,
    });
    const newer = makeClient({
      id: ClientId("conn-new"),
      userId: UserId(5),
      username: "smith",
      connectedAt: 200,
    });
    const selection: ClientSelection = { userId: UserId(5) };
    // Order the older one last to prove it is connectedAt, not array order, that wins.
    const result = resolveSelection(selection, [newer, older]);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.client).toBe(newer);
  });

  it("auto-resolves the newest socket of a single account with no selection", () => {
    const older = makeClient({
      id: ClientId("conn-old"),
      userId: UserId(8),
      username: "tank",
      connectedAt: 10,
    });
    const newer = makeClient({
      id: ClientId("conn-new"),
      userId: UserId(8),
      username: "tank",
      connectedAt: 20,
    });
    const result = resolveSelection({}, [older, newer]);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.client).toBe(newer);
  });
});
