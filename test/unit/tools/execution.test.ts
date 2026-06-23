import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import profileCode from "../../../src/tools/execution/profile-code.js";
import executeAndWait from "../../../src/tools/execution/execute-and-wait.js";
import batchExecute from "../../../src/tools/execution/batch-execute.js";
import runLoop from "../../../src/tools/execution/run-loop.js";
import { executionTools } from "../../../src/tools/execution/index.js";

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

describe("execution tools", () => {
  it("exports all 18 tools with unique names in the Execution category", () => {
    expect(executionTools).toHaveLength(18);
    const names = executionTools.map((t) => t.name);
    expect(new Set(names).size).toBe(18);
    for (const tool of executionTools) {
      expect(tool.category).toBe("Execution");
    }
    expect(names).toEqual([
      "run-luau",
      "eval-expression",
      "execute",
      "execute-and-wait",
      "batch-execute",
      "profile-code",
      "measure-memory",
      "run-loop",
      "run-deferred",
      "run-with-timeout",
      "execute-file",
      "script",
      "script-fanout",
      "vm-reset",
      "playbook-save",
      "playbook-list",
      "playbook-run",
      "playbook-delete",
    ]);
  });

  describe("profile-code", () => {
    it("compiles the snippet, clamps runs, and passes a 20s budget", async () => {
      const canned = { runs: 3, totalMs: 1.5, avgMs: 0.5, errorCount: 0 };
      const { ctx, calls } = stubContext(canned);
      const input = profileCode.input.parse({ code: "return 1 + 1", runs: 3 });

      const result = await profileCode.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      expect(source).toContain('loadstring("return 1 + 1", "=profile-code")');
      expect(source).toContain("local __runs = 3");
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBeUndefined();
    });

    it("clamps runs above the 100000 ceiling and passes threadContext through", async () => {
      const { ctx, calls } = stubContext({});
      const input = profileCode.input.parse({
        code: "return 1",
        runs: 999999,
        threadContext: 8,
      });

      await profileCode.execute(input, ctx);

      expect(calls[0]?.source).toContain("local __runs = 100000");
      expect(calls[0]?.options?.threadContext).toBe(8);
    });

    it("is a state-mutating tool", () => {
      expect(profileCode.mutatesState).toBe(true);
    });
  });

  describe("execute-and-wait", () => {
    it("captures output via LogService.MessageOut and pcall-runs the compiled code", async () => {
      const canned = { ok: true, returnValue: 42, output: ["hello"] };
      const { ctx, calls } = stubContext(canned);
      const input = executeAndWait.input.parse({ code: "print('hello') return 42" });

      const result = await executeAndWait.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source } = calls[0]!;
      expect(source).toContain('loadstring("print(\'hello\') return 42", "=execute-and-wait")');
      expect(source).toContain('game:GetService("LogService")');
      expect(source).toContain("MessageOut:Connect");
      // encodes the first return value via the shared __encode helper.
      expect(source).toContain("pcall(__encode, __packed[2])");
    });

    it("is a state-mutating tool", () => {
      expect(executeAndWait.mutatesState).toBe(true);
    });
  });

  describe("batch-execute", () => {
    it("emits one indexed snippet line per snippet and returns results", async () => {
      const canned = {
        results: [
          { index: 1, ok: true, value: 1 },
          { index: 2, ok: false, error: "runtime error: boom" },
        ],
      };
      const { ctx, calls } = stubContext(canned);
      const input = batchExecute.input.parse({
        snippets: ["return 1", "error('boom')"],
      });

      const result = await batchExecute.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source } = calls[0]!;
      expect(source).toContain('__snippets[1] = "return 1"');
      expect(source).toContain("__snippets[2] = \"error('boom')\"");
      expect(source).toContain("pcall(__encode, __packed[2])");
    });

    it("rejects an empty snippets array at the schema boundary", () => {
      expect(() => batchExecute.input.parse({ snippets: [] })).toThrow();
    });
  });

  describe("run-loop", () => {
    it("rejects up front when iterations*delayMs exceeds the connector ceiling", async () => {
      const { ctx, calls } = stubContext({});
      const input = runLoop.input.parse({ code: "return 1", iterations: 1000, delayMs: 200 });

      const result = await runLoop.execute(input, ctx);

      expect(result.isError).toBe(true);
      expect((result.data as { error: string }).error).toContain("exceeds");
      // The over-budget loop never reaches the client.
      expect(calls).toHaveLength(0);
    });

    it("runs within budget and clamps the timeout to at least 20s", async () => {
      const canned = { iterations: 5, results: {}, errorCount: 0, errors: {} };
      const { ctx, calls } = stubContext(canned);
      const input = runLoop.input.parse({ code: "return 1" });

      const result = await runLoop.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls[0]?.source).toContain("local __iters = 5");
      expect(calls[0]?.options?.timeoutMs).toBe(20000);
    });
  });
});
