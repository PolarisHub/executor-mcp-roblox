import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import listSignalConnections from "../../../src/tools/signals/list-signal-connections.js";
import fireSignal from "../../../src/tools/signals/fire-signal.js";
import getSignalArguments from "../../../src/tools/signals/get-signal-arguments.js";
import { signalsTools } from "../../../src/tools/signals/index.js";

/**
 * A minimal ToolContext stub whose runLuau records the source string and the
 * options it was called with, then returns a canned value. No socket, no game —
 * we only assert that the tool builds the expected Luau and returns { data }.
 */
function stubContext(canned: unknown): {
  ctx: ToolContext;
  calls: Array<{ source: string; options?: LuauOptions }>;
} {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const ctx = {
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return canned;
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("signals tools", () => {
  it("exports all 16 tools with unique names in the Signals & Connections category", () => {
    expect(signalsTools).toHaveLength(16);
    const names = signalsTools.map((t) => t.name);
    expect(new Set(names).size).toBe(16);
    for (const tool of signalsTools) {
      expect(tool.category).toBe("Signals & Connections");
    }
  });

  it("marks exactly the four firing/mutating tools as mutatesState", () => {
    const mutating = signalsTools
      .filter((t) => t.mutatesState === true)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual(
      ["fire-connection", "fire-signal", "replicate-signal", "set-connection-state"].sort(),
    );
  });

  describe("list-signal-connections", () => {
    it("builds source that resolves the signal and returns the canned data", async () => {
      const canned = { Signal: "Touched", ConnectionCount: 2, Connections: [] } as const;
      const { ctx, calls } = stubContext(canned);
      const input = listSignalConnections.input.parse({
        instancePath: "game.Workspace.Door",
        signalName: "Touched",
      });

      const result = await listSignalConnections.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      // Quoted args spliced into the resolver call.
      expect(source).toContain('__resolveSignal("game.Workspace.Door", "Touched")');
      // Prelude + connection enumeration are present.
      expect(source).toContain("local conns, cerr = __getConns(sig)");
      expect(source).toContain("ConnectionCount = #conns");
      // includeFunctionInfo defaults to true.
      expect(source).toContain("local withFn = true");
      // Read-only tool: 20s budget, threadContext passes through (undefined here).
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBeUndefined();
    });

    it("passes threadContext through to runLuau when supplied", async () => {
      const { ctx, calls } = stubContext({});
      const input = listSignalConnections.input.parse({
        instancePath: "game.Workspace.Door",
        threadContext: 2,
      });

      await listSignalConnections.execute(input, ctx);

      expect(calls[0]?.options?.threadContext).toBe(2);
    });
  });

  describe("fire-signal", () => {
    it("splices the firesignal call and a string arg into the source", async () => {
      const canned = { Fired: true, ArgCount: 1 };
      const { ctx, calls } = stubContext(canned);
      const input = fireSignal.input.parse({
        instancePath: "game.Workspace.Door",
        signalName: "Touched",
        args: [{ kind: "string", value: "hello" }],
      });

      const result = await fireSignal.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source } = calls[0]!;
      expect(source).toContain("firesignal(sig, __arg0)");
      expect(source).toContain('local __arg0 = "hello"');
      expect(source).toContain(
        'if type(firesignal) ~= "function" then return { error = "firesignal is not available in this executor." } end',
      );
    });

    it("is a state-mutating tool", () => {
      expect(fireSignal.mutatesState).toBe(true);
    });
  });

  describe("get-signal-arguments", () => {
    it("guards getsignalarguments and returns the canned arguments", async () => {
      const canned = { Signal: "OnClientEvent", Arguments: { "1": "string" } };
      const { ctx, calls } = stubContext(canned);
      const input = getSignalArguments.input.parse({
        instancePath: "game.ReplicatedStorage.MyRemote",
        signalName: "OnClientEvent",
      });

      const result = await getSignalArguments.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source } = calls[0]!;
      expect(source).toContain('if type(getsignalarguments) ~= "function" then');
      expect(source).toContain("local ok, res = pcall(getsignalarguments, sig)");
      expect(source).toContain(
        '__resolveSignal("game.ReplicatedStorage.MyRemote", "OnClientEvent")',
      );
    });
  });
});
