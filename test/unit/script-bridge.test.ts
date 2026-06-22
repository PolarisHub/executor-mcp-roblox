import { describe, expect, it, vi } from "vitest";

import { ScriptBridge } from "../../src/application/services/script-bridge.js";
import type { ToolInvoker } from "../../src/application/services/tool-invoker.js";
import { SessionId } from "../../src/domain/shared/ids.js";

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
    });
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
