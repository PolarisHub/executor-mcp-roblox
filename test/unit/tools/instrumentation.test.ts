import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import countFunctionCalls from "../../../src/tools/instrumentation/count-function-calls.js";
import spoofFunctionReturn from "../../../src/tools/instrumentation/spoof-function-return.js";
import watchPropertyChanges from "../../../src/tools/instrumentation/watch-property-changes.js";
import captureLogOutput from "../../../src/tools/instrumentation/capture-log-output.js";
import { instrumentationTools } from "../../../src/tools/instrumentation/index.js";

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

describe("instrumentation tools", () => {
  it("exports all 8 tools with unique names in the Instrumentation category", () => {
    expect(instrumentationTools).toHaveLength(8);
    const names = instrumentationTools.map((t) => t.name);
    expect(new Set(names).size).toBe(8);
    for (const tool of instrumentationTools) {
      expect(tool.category).toBe("Instrumentation");
    }
  });

  it("marks the hook/invoke tools as mutatesState and the two read windows as not", () => {
    const mutating = instrumentationTools
      .filter((t) => t.mutatesState === true)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual(
      [
        "block-function",
        "call-closure",
        "count-function-calls",
        "hook-and-log-function",
        "spoof-function-return",
        "trace-call-durations",
      ].sort(),
    );
    const readOnly = instrumentationTools
      .filter((t) => t.mutatesState !== true)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual(["capture-log-output", "watch-property-changes"].sort());
  });

  describe("count-function-calls", () => {
    it("builds a start hook keyed by the quoted functionPath", async () => {
      const canned = { started: true, key: "getgenv().foo" };
      const { ctx, calls } = stubContext(canned);
      const input = countFunctionCalls.input.parse({
        action: "start",
        functionPath: "getgenv().foo",
      });

      const result = await countFunctionCalls.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      // Registry keyed by the quoted expression and guarded by getgenv/hookfunction.
      expect(source).toContain('local __KEY = "getgenv().foo"');
      expect(source).toContain("__genv.__mcp_callCounts");
      expect(source).toContain('if type(hookfunction) ~= "function" then');
      expect(source).toContain('local __OWNERTAG = "count:" .. __KEY');
      // Legacy 20s budget; threadContext passes through (undefined here).
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBeUndefined();
    });

    it("emits the fetch body when action='fetch'", async () => {
      const { ctx, calls } = stubContext({ calls: 3 });
      const input = countFunctionCalls.input.parse({
        action: "fetch",
        functionPath: "getgenv().foo",
      });

      await countFunctionCalls.execute(input, ctx);

      const { source } = calls[0]!;
      expect(source).toContain(
        "return { key = __KEY, active = entry.active == true, calls = entry.calls or 0 }",
      );
      expect(source).not.toContain("hookfunction(target, hook)");
    });

    it("refuses action='start' without a functionPath (handled tool-level error)", async () => {
      const { ctx, calls } = stubContext({});
      // The validation runs before runLuau, so functionPath is optional in the schema.
      const input = countFunctionCalls.input.parse({ action: "start" });

      const result = await countFunctionCalls.execute(input, ctx);

      expect(result.isError).toBe(true);
      expect((result.data as { error: string }).error).toContain("functionPath is required");
      expect(calls).toHaveLength(0);
    });
  });

  describe("spoof-function-return", () => {
    it("splices a buildValueExpr'd raw return value into the start stub", async () => {
      const canned = { started: true, returns: "true" };
      const { ctx, calls } = stubContext(canned);
      const input = spoofFunctionReturn.input.parse({
        action: "start",
        functionPath: "getsenv(script).isValid",
        returnValue: { kind: "raw", value: "true" },
      });

      const result = await spoofFunctionReturn.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      // raw kind is evaluated via loadstring("return " .. <quoted>).
      expect(source).toContain('(loadstring("return " .. "true"))()');
      expect(source).toContain("__genv.__mcp_spoofReturns");
      expect(source).toContain('local __OWNERTAG = "spoof:" .. __KEY');
      expect(options?.timeoutMs).toBe(20000);
    });

    it("refuses action='start' without a returnValue", async () => {
      const { ctx, calls } = stubContext({});
      const input = spoofFunctionReturn.input.parse({
        action: "start",
        functionPath: "getsenv(script).isValid",
      });

      const result = await spoofFunctionReturn.execute(input, ctx);

      expect(result.isError).toBe(true);
      expect((result.data as { error: string }).error).toContain("returnValue is required");
      expect(calls).toHaveLength(0);
    });

    it("uses a 'nil' return expression for action='stop'", async () => {
      const { ctx, calls } = stubContext({ stopped: true });
      const input = spoofFunctionReturn.input.parse({
        action: "stop",
        functionPath: "getsenv(script).isValid",
      });

      await spoofFunctionReturn.execute(input, ctx);

      const { source } = calls[0]!;
      expect(source).toContain("No active spoof for this functionPath");
    });
  });

  describe("watch-property-changes", () => {
    it("connects Changed, clamps the duration, and budgets timeout = duration + 15000", async () => {
      const canned = { Path: "Workspace.Part", changeCount: 0, changes: [] };
      const { ctx, calls } = stubContext(canned);
      const input = watchPropertyChanges.input.parse({
        instancePath: "game.Workspace.Part",
        durationMs: 2000,
        limit: 50,
      });

      const result = await watchPropertyChanges.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      expect(source).toContain("inst.Changed:Connect(function(prop)");
      expect(source).toContain("local CAP = 50");
      expect(source).toContain("local durationSec = 2000 / 1000");
      expect(source).toContain("task.wait(durationSec)");
      // Round-trip budget is the in-game window plus a 15s buffer.
      expect(options?.timeoutMs).toBe(17000);
    });

    it("clamps a huge durationMs to the 30000 max", async () => {
      const { ctx, calls } = stubContext({});
      const input = watchPropertyChanges.input.parse({
        instancePath: "game.Workspace.Part",
        durationMs: 999999,
      });

      await watchPropertyChanges.execute(input, ctx);

      const { source, options } = calls[0]!;
      expect(source).toContain("local durationSec = 30000 / 1000");
      expect(options?.timeoutMs).toBe(45000);
    });

    it("is a read-only window (does not mutate game state)", () => {
      expect(watchPropertyChanges.mutatesState).not.toBe(true);
    });
  });

  describe("capture-log-output", () => {
    it("connects LogService.MessageOut on start and is read-only", async () => {
      const canned = { started: true, max: 1000 };
      const { ctx, calls } = stubContext(canned);
      const input = captureLogOutput.input.parse({ action: "start" });

      const result = await captureLogOutput.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      expect(source).toContain('game:GetService("LogService")');
      expect(source).toContain("logService.MessageOut:Connect");
      expect(options?.timeoutMs).toBe(15000);
      expect(captureLogOutput.mutatesState).not.toBe(true);
    });

    it("clamps the fetch limit into the source and uses a 20s budget", async () => {
      const { ctx, calls } = stubContext({ count: 0, entries: [] });
      const input = captureLogOutput.input.parse({ action: "fetch", limit: 5000 });

      await captureLogOutput.execute(input, ctx);

      const { source, options } = calls[0]!;
      // limit is clamped to the 1000-entry buffer.
      expect(source).toContain("local limit = 1000");
      expect(options?.timeoutMs).toBe(20000);
    });
  });
});
