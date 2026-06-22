import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import listGcFunctions from "../../../src/tools/reverse-engineering/list-gc-functions.js";
import findFunctionsByConstant from "../../../src/tools/reverse-engineering/find-functions-by-constant.js";
import compareGcSnapshots from "../../../src/tools/reverse-engineering/compare-gc-snapshots.js";
import { reBatchC } from "../../../src/tools/reverse-engineering/_batch-c.js";

/** Records every runLuau call and returns a canned decoded value. */
function mockContext(returnValue: unknown = { ok: true }): ToolContext & {
  calls: Array<{ source: string; options?: LuauOptions }>;
} {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const ctx = {
    calls,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return ctx.logger;
      },
    },
    signal: new AbortController().signal,
    client: undefined,
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return returnValue;
    },
    clients: {
      list() {
        return [];
      },
      get() {
        return undefined;
      },
      count() {
        return 0;
      },
    },
    session: {
      id: "test" as never,
      label: "test",
      selection: { kind: "auto" } as never,
      select() {},
      clear() {},
      resolve() {
        return { kind: "none" } as never;
      },
    },
  } as unknown as ToolContext & { calls: Array<{ source: string; options?: LuauOptions }> };
  return ctx;
}

describe("Reverse Engineering — standalone batch C", () => {
  it("exports all 5 tools, each tagged Reverse Engineering, read-only, client-bound", () => {
    expect(reBatchC).toHaveLength(5);
    for (const tool of reBatchC) {
      expect(tool.category).toBe("Reverse Engineering");
      // These are read-only getgc scans / snapshots — none mutate live game state.
      expect(tool.mutatesState ?? false).toBe(false);
      expect(tool.requiresClient ?? true).toBe(true);
    }
    const names = reBatchC.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
    expect(names).toEqual([
      "list-gc-functions",
      "lookup-function",
      "get-function-upvalues",
      "find-functions-by-constant",
      "compare-gc-snapshots",
    ]);
  });

  describe("list-gc-functions", () => {
    it("builds the getgc walk, carries the 30s timeout, and returns the decoded table", async () => {
      const decoded = { scanned: 12, returned: 2, results: [] };
      const ctx = mockContext(decoded);

      const result = await listGcFunctions.execute(
        { nameQuery: "Fire", includeCClosures: false, limit: 100 },
        ctx,
      );

      expect(result.data).toBe(decoded);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      // The legacy whole-GC deadline (30000) is carried into runLuau options.
      expect(options?.timeoutMs).toBe(30000);
      // No threadContext supplied -> falls back to the gateway default (not passed).
      expect(options?.threadContext).toBeUndefined();
      // Filters are funnelled through q() as Luau literals.
      expect(source).toContain('local nameNeedle = "Fire"');
      expect(source).toContain('local sourceNeedle = ""');
      expect(source).toContain("local includeC = false");
      expect(source).toContain("local maxResults = 100");
      // The legacy setthreadidentity prefix must be gone.
      expect(source).not.toContain("setthreadidentity");
    });

    it("clamps the limit and forwards threadContext through the runLuau options", async () => {
      const ctx = mockContext();
      await listGcFunctions.execute(
        { includeCClosures: true, limit: 99999, threadContext: 3 },
        ctx,
      );
      const { source, options } = ctx.calls[0]!;
      // limit is clamped to the legacy ceiling of 1000.
      expect(source).toContain("local maxResults = 1000");
      expect(source).toContain("local includeC = true");
      // Omitted nameQuery/sourceQuery default to empty literals.
      expect(source).toContain('local nameNeedle = ""');
      expect(options?.threadContext).toBe(3);
    });
  });

  describe("find-functions-by-constant", () => {
    it("escapes a constant query containing quotes so the chunk stays valid", async () => {
      const decoded = { constantQuery: 'say "hi"', scanned: 5, returned: 1, results: [] };
      const ctx = mockContext(decoded);

      const result = await findFunctionsByConstant.execute(
        { constantQuery: 'say "hi"', includeCClosures: false, limit: 30 },
        ctx,
      );

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(45000);
      // q() => JSON.stringify => embedded quotes are backslash-escaped.
      expect(source).toContain('local needle = "say \\"hi\\""');
      // It gates on debug.getconstants availability (verbatim legacy body).
      expect(source).toContain("debug.getconstants is not available in this executor.");
      expect(source).toContain("local maxResults = 30");
    });
  });

  describe("compare-gc-snapshots", () => {
    it("emits the capture branch (stores baseline) with the 30s timeout", async () => {
      const decoded = { action: "capture", name: "leakhunt", ts: 1, counts: {} };
      const ctx = mockContext(decoded);

      const result = await compareGcSnapshots.execute(
        { action: "capture", snapshotName: "leakhunt" },
        ctx,
      );

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(30000);
      // snapshotName flows through q().
      expect(source).toContain('local NAME = "leakhunt"');
      // The capture branch stores the census; the compare-only diff code is absent.
      expect(source).toContain('action = "capture"');
      expect(source).toContain("store[NAME] = {");
      expect(source).not.toContain("freedApprox");
    });

    it("emits the compare branch (diffs against the baseline) for action='compare'", async () => {
      const ctx = mockContext({ action: "compare" });

      await compareGcSnapshots.execute(
        { action: "compare", snapshotName: "default", threadContext: 8 },
        ctx,
      );

      const { source, options } = ctx.calls[0]!;
      // The compare branch computes deltas and the freed/new function diff.
      expect(source).toContain('action = "compare"');
      expect(source).toContain("freedApprox");
      expect(source).toContain("countDeltas");
      // capture-only storage write must not be present in the compare branch.
      expect(source).not.toContain("store[NAME] = {");
      expect(options?.threadContext).toBe(8);
    });
  });
});
