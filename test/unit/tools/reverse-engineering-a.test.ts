import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import listGcTables from "../../../src/tools/reverse-engineering/list-gc-tables.js";
import inspectInstanceMetatable from "../../../src/tools/reverse-engineering/inspect-instance-metatable.js";
import findConstantsXref from "../../../src/tools/reverse-engineering/find-constants-xref.js";
import { reBatchA } from "../../../src/tools/reverse-engineering/_batch-a.js";

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

describe("Reverse Engineering — reverse-pack batch A", () => {
  it("exports all 12 tools, each tagged as a read-only Reverse Engineering scan", () => {
    expect(reBatchA).toHaveLength(12);
    for (const tool of reBatchA) {
      expect(tool.category).toBe("Reverse Engineering");
      // These are read-only runtime scans — none of them mutate live state.
      expect(tool.mutatesState ?? false).toBe(false);
      expect(tool.requiresClient ?? true).toBe(true);
    }
    const names = reBatchA.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
  });

  describe("list-gc-tables", () => {
    it("inlines the lowercased query + clamped limit and returns the decoded table", async () => {
      const decoded = { count: 2, results: [] };
      const ctx = mockContext(decoded);

      const result = await listGcTables.execute({ query: "Coins", limit: 100 }, ctx);

      expect(result.data).toBe(decoded);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      // Default reverse-pack execLua deadline carried into runLuau options.
      expect(options?.timeoutMs).toBe(30000);
      // No threadContext supplied -> falls back to the gateway default (not passed).
      expect(options?.threadContext).toBeUndefined();
      // The query is funnelled through q() as a Luau literal; limit is floored inline.
      expect(source).toContain('local query = string.lower("Coins")');
      expect(source).toContain("math.min(1000, 100)");
      // The legacy setthreadidentity prefix must be gone.
      expect(source).not.toContain("setthreadidentity");
    });

    it("forwards threadContext through the runLuau options when supplied", async () => {
      const ctx = mockContext();
      await listGcTables.execute({ query: "", limit: 100, threadContext: 5 }, ctx);
      expect(ctx.calls[0]?.options?.threadContext).toBe(5);
    });
  });

  describe("inspect-instance-metatable", () => {
    it("compiles the resolved expression and returns the decoded result", async () => {
      const decoded = { Instance: "game.Players.LocalPlayer", KeyCount: 3, Keys: [] };
      const ctx = mockContext(decoded);

      const result = await inspectInstanceMetatable.execute(
        { instancePath: "game.Players.LocalPlayer" },
        ctx,
      );

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(30000);
      expect(source).toContain('loadstring("return " .. "game.Players.LocalPlayer")');
      expect(source).toContain("getrawmetatable");
    });
  });

  describe("find-constants-xref", () => {
    it("escapes a query that contains quotes so the chunk stays valid and uses the 45s deadline", async () => {
      const ctx = mockContext({ query: "", count: 0, results: [] });

      await findConstantsXref.execute({ constantQuery: 'say "hi"', limit: 120 }, ctx);

      const { source, options } = ctx.calls[0]!;
      // The whole-GC constant scan keeps the legacy 45s deadline.
      expect(options?.timeoutMs).toBe(45000);
      // q() => JSON.stringify => embedded quotes are backslash-escaped.
      expect(source).toContain('local q = string.lower("say \\"hi\\"")');
      expect(source).toContain("math.min(2000, 120)");
    });
  });
});
