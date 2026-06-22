import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import scanProtoFunctions from "../../../src/tools/reverse-engineering/scan-proto-functions.js";
import listGlobalEnvKeys from "../../../src/tools/reverse-engineering/list-global-env-keys.js";
import findPathReferences from "../../../src/tools/reverse-engineering/find-path-references.js";
import { reBatchB } from "../../../src/tools/reverse-engineering/_batch-b.js";

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

describe("Reverse Engineering tools — batch B", () => {
  it("registers all 12 tools, each tagged Reverse Engineering and read-only", () => {
    expect(reBatchB).toHaveLength(12);
    for (const tool of reBatchB) {
      expect(tool.category).toBe("Reverse Engineering");
      // These are read-only GC/descendant scans — none mutate live state.
      expect(tool.mutatesState ?? false).toBe(false);
      expect(tool.requiresClient ?? true).toBe(true);
    }
    const names = reBatchB.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
  });

  describe("scan-proto-functions", () => {
    it("lowercases and inlines the query, carries the 45s timeout, returns the decoded table", async () => {
      const decoded = { query: "render", count: 1, results: [] };
      const ctx = mockContext(decoded);

      const result = await scanProtoFunctions.execute({ query: "Render", limit: 100 }, ctx);

      expect(result.data).toBe(decoded);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      // The legacy whole-GC scan deadline is carried into the runLuau options.
      expect(options?.timeoutMs).toBe(45000);
      // No threadContext supplied -> falls back to the gateway default (not passed).
      expect(options?.threadContext).toBeUndefined();
      // The query is funnelled through q() as a Luau literal.
      expect(source).toContain('local q = string.lower("Render")');
      // The legacy setthreadidentity prefix must be gone.
      expect(source).not.toContain("setthreadidentity");
      expect(source).toContain("debug.getprotos");
    });

    it("forwards threadContext through the runLuau options when supplied", async () => {
      const ctx = mockContext();
      await scanProtoFunctions.execute({ query: "", limit: 100, threadContext: 7 }, ctx);
      expect(ctx.calls[0]?.options?.threadContext).toBe(7);
    });
  });

  describe("list-global-env-keys", () => {
    it("inlines the floored limit and uses the default 30s timeout", async () => {
      const decoded = { count: 0, results: [] };
      const ctx = mockContext(decoded);

      const result = await listGlobalEnvKeys.execute({ query: "", limit: 42 }, ctx);

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      // No per-tool override -> the execLua default deadline (30s).
      expect(options?.timeoutMs).toBe(30000);
      expect(source).toContain("math.min(5000, 42)");
      expect(source).toContain("(getgenv and getgenv()) or _G");
    });
  });

  describe("find-path-references", () => {
    it("escapes a query containing quotes so the chunk stays valid", async () => {
      const ctx = mockContext({ query: "", count: 0, results: [] });

      await findPathReferences.execute({ query: 'say "hi"', limit: 150 }, ctx);

      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(45000);
      // q() => JSON.stringify => embedded quotes are backslash-escaped.
      expect(source).toContain('string.lower("say \\"hi\\"")');
    });
  });
});
