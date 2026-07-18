import { describe, expect, it, vi } from "vitest";

import { ScriptBridge } from "../../src/application/services/script-bridge.js";
import type { ToolInvoker } from "../../src/application/services/tool-invoker.js";
import { ClientId, SessionId } from "../../src/domain/shared/ids.js";

function fakeInvoker(impl: ToolInvoker["invoke"]): ToolInvoker {
  return { invoke: impl } as unknown as ToolInvoker;
}

describe("ScriptBridge", () => {
  it("runs a tool for a valid token and returns its data", async () => {
    const bridge = new ScriptBridge();
    const invoke = vi.fn(async (req: { toolName: string; input: unknown }) => ({
      data: { tool: req.toolName, input: req.input },
    }));
    bridge.attach(fakeInvoker(invoke));

    const { token } = bridge.mint(SessionId("s1"), "label");
    const result = await bridge.run(token, "get-players", { a: 1 });

    expect(result).toEqual({ ok: true, data: { tool: "get-players", input: { a: 1 } } });
    expect(invoke).toHaveBeenCalledWith({
      toolName: "get-players",
      input: { a: 1 },
      sessionId: "s1",
      sessionLabel: "label",
      priority: "nested",
    });
  });

  it("pins nested calls to the token's bound client via an injected `client`", async () => {
    const bridge = new ScriptBridge();
    const invoke = vi.fn(async () => ({ data: {} }));
    bridge.attach(fakeInvoker(invoke));

    const { token } = bridge.mint(SessionId("s1"), "label", ClientId("client-bob"));
    await bridge.run(token, "get-players", { a: 1 });

    expect(invoke).toHaveBeenCalledWith({
      toolName: "get-players",
      input: { a: 1, client: "client-bob" },
      sessionId: "s1",
      sessionLabel: "label",
      priority: "nested",
    });
  });

  it("injects the bound client even when the nested call passes no args", async () => {
    const bridge = new ScriptBridge();
    const invoke = vi.fn(async () => ({ data: {} }));
    bridge.attach(fakeInvoker(invoke));

    const { token } = bridge.mint(SessionId("s1"), "label", ClientId("client-bob"));
    await bridge.run(token, "get-players", undefined);

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ input: { client: "client-bob" } }),
    );
  });

  it("lets an explicit `client` in nested args win over the token's bound client", async () => {
    const bridge = new ScriptBridge();
    const invoke = vi.fn(async () => ({ data: {} }));
    bridge.attach(fakeInvoker(invoke));

    const { token } = bridge.mint(SessionId("s1"), "label", ClientId("client-bob"));
    await bridge.run(token, "get-players", { client: "alice" });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ input: { client: "alice" } }),
    );
  });

  it("forwards the token's agent lane onto nested calls", async () => {
    const bridge = new ScriptBridge();
    const invoke = vi.fn(async () => ({ data: {} }));
    bridge.attach(fakeInvoker(invoke));

    const { token } = bridge.mint(SessionId("s1"), "label", ClientId("client-bob"), "researcher");
    await bridge.run(token, "get-players", { a: 1 });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ input: { a: 1, client: "client-bob", agent: "researcher" } }),
    );
  });

  it("downgrades a nested call aimed at a different game to normal priority", async () => {
    const bridge = new ScriptBridge();
    const invoke = vi.fn(async () => ({ data: {} }));
    bridge.attach(fakeInvoker(invoke));

    const { token } = bridge.mint(SessionId("s1"), "label", ClientId("client-bob"));
    // Explicit client targets a DIFFERENT game than the script's own — it must not
    // ride game-alice's reserved nested lane.
    await bridge.run(token, "get-players", { client: "client-alice" });

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ priority: "normal" }));
  });

  it("keeps nested priority for a call on the script's own game", async () => {
    const bridge = new ScriptBridge();
    const invoke = vi.fn(async () => ({ data: {} }));
    bridge.attach(fakeInvoker(invoke));

    const { token } = bridge.mint(SessionId("s1"), "label", ClientId("client-bob"));
    await bridge.run(token, "get-players", {});

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ priority: "nested" }));
  });

  it("rejects an unknown or disposed token", async () => {
    const bridge = new ScriptBridge();
    bridge.attach(fakeInvoker(async () => ({ data: {} })));

    expect(await bridge.run("nope", "get-players", {})).toEqual({
      ok: false,
      error: "invalid or expired script token",
    });

    const { token, dispose } = bridge.mint(SessionId("s1"), "label");
    dispose();
    expect((await bridge.run(token, "get-players", {})).ok).toBe(false);
  });

  it("rejects calls once the per-script RPC budget is exhausted", async () => {
    const bridge = new ScriptBridge();
    const invoke = vi.fn(async () => ({ data: {} }));
    bridge.attach(fakeInvoker(invoke));
    const { token } = bridge.mint(SessionId("s1"), "label", undefined, undefined, 2);

    expect((await bridge.run(token, "get-players", {})).ok).toBe(true);
    expect((await bridge.run(token, "get-players", {})).ok).toBe(true);
    const blocked = await bridge.run(token, "get-players", {});
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("BUDGET_EXCEEDED");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("refuses to call the script tool itself (no recursion)", async () => {
    const bridge = new ScriptBridge();
    const invoke = vi.fn(async () => ({ data: {} }));
    bridge.attach(fakeInvoker(invoke));
    const { token } = bridge.mint(SessionId("s1"), "label");

    const result = await bridge.run(token, "script", {});
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("surfaces a tool's handled error as ok:false", async () => {
    const bridge = new ScriptBridge();
    bridge.attach(fakeInvoker(async () => ({ data: "boom", isError: true })));
    const { token } = bridge.mint(SessionId("s1"), "label");

    expect(await bridge.run(token, "find-functions-by-name", {})).toEqual({
      ok: false,
      error: "boom",
    });
  });

  it("normalizes a thrown error into ok:false", async () => {
    const bridge = new ScriptBridge();
    bridge.attach(
      fakeInvoker(async () => {
        throw new Error("kaboom");
      }),
    );
    const { token } = bridge.mint(SessionId("s1"), "label");

    const result = await bridge.run(token, "get-players", {});
    expect(result.ok).toBe(false);
  });
});
