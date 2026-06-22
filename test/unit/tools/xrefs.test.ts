import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import listStrings from "../../../src/tools/xrefs/list-strings.js";
import findStringXrefs from "../../../src/tools/xrefs/find-string-xrefs.js";
import disassembleFunction from "../../../src/tools/xrefs/disassemble-function.js";
import searchBytecode from "../../../src/tools/xrefs/search-bytecode.js";
import { xrefsTools } from "../../../src/tools/xrefs/index.js";

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

describe("Disassembly & Xrefs tools", () => {
  it("registers all 12 tools in the category index, each tagged correctly", () => {
    expect(xrefsTools).toHaveLength(12);
    for (const tool of xrefsTools) {
      expect(tool.category).toBe("Disassembly & Xrefs");
      // These are read-only whole-GC scans — none of them mutate live state.
      expect(tool.mutatesState ?? false).toBe(false);
      expect(tool.requiresClient ?? true).toBe(true);
    }
    const names = xrefsTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
  });

  describe("list-strings", () => {
    it("builds a GC-walking chunk, passes the 45s timeout, and returns the decoded table", async () => {
      const decoded = { uniqueStrings: 2, functionsScanned: 10, truncatedScan: false, strings: [] };
      const ctx = mockContext(decoded);

      const result = await listStrings.execute(
        { filter: "Fire", minLength: 4, limit: 200, maxScan: 9000 },
        ctx,
      );

      expect(result.data).toBe(decoded);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      // The legacy whole-GC scan deadline is carried into the runLuau options.
      expect(options?.timeoutMs).toBe(45000);
      // No threadContext supplied -> falls back to the gateway default (not passed).
      expect(options?.threadContext).toBeUndefined();
      // The filter is funnelled through q() as a Luau literal, and the GC walker is present.
      expect(source).toContain('local filter = "Fire"');
      expect(source).toContain("__eachFn(9000");
      // The legacy setthreadidentity prefix must be gone.
      expect(source).not.toContain("setthreadidentity");
    });

    it("forwards threadContext through the runLuau options when supplied", async () => {
      const ctx = mockContext();
      await listStrings.execute(
        { filter: "", minLength: 4, limit: 200, maxScan: 9000, threadContext: 2 },
        ctx,
      );
      expect(ctx.calls[0]?.options?.threadContext).toBe(2);
    });
  });

  describe("find-string-xrefs", () => {
    it("inlines the query and exact flag and returns the decoded result", async () => {
      const decoded = { query: "RemoteEvent", exact: true, matchCount: 1, matches: [] };
      const ctx = mockContext(decoded);

      const result = await findStringXrefs.execute(
        { query: "RemoteEvent", exact: true, limit: 100, maxScan: 9000 },
        ctx,
      );

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(45000);
      expect(source).toContain('local query = "RemoteEvent"');
      expect(source).toContain("local exact = true");
    });

    it("escapes a query that contains quotes so the chunk stays valid", async () => {
      const ctx = mockContext();
      await findStringXrefs.execute(
        { query: 'say "hi"', exact: false, limit: 100, maxScan: 9000 },
        ctx,
      );
      // q() => JSON.stringify => embedded quotes are backslash-escaped.
      expect(ctx.calls[0]?.source).toContain('local query = "say \\"hi\\""');
      expect(ctx.calls[0]?.source).toContain("local exact = false");
    });
  });

  describe("disassemble-function", () => {
    it("compiles the resolved expression and gates the constant/upvalue dumps", async () => {
      const decoded = { Info: { ptr: "0x1" }, ConstantCount: 3, UpvalueCount: 1 };
      const ctx = mockContext(decoded);

      const result = await disassembleFunction.execute(
        {
          functionPath: "getgenv().myFunc",
          includeConstants: true,
          includeUpvalues: false,
        },
        ctx,
      );

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(45000);
      expect(source).toContain('loadstring("return " .. "getgenv().myFunc")');
      // includeConstants=true / includeUpvalues=false are inlined as literals.
      expect(source).toContain("if true then result.Constants = __dumpList(consts) end");
      expect(source).toContain("if false then result.Upvalues = __dumpList(ups) end");
    });
  });

  describe("search-bytecode (JS-side hex validation)", () => {
    it("rejects an odd-length hex pattern without ever calling runLuau", async () => {
      const ctx = mockContext();
      const result = await searchBytecode.execute(
        { hexPattern: "1a2", limit: 50, maxScan: 6000 },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect((result.data as { error: string }).error).toContain("Invalid hexPattern");
      expect(ctx.calls).toHaveLength(0);
    });

    it("normalizes a spaced hex pattern and embeds it in the chunk", async () => {
      const ctx = mockContext({ matchCount: 0, matches: [] });
      await searchBytecode.execute({ hexPattern: "1A 2B 3C", limit: 50, maxScan: 6000 }, ctx);
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.calls[0]?.source).toContain('local pattern = "1a2b3c"');
    });
  });
});
