import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import filterGc from "../../../src/tools/volt-extras/filter-gc.js";
import getCallStack from "../../../src/tools/volt-extras/get-call-stack.js";
import cacheReplace from "../../../src/tools/volt-extras/cache-replace.js";
import getScriptBytecode from "../../../src/tools/volt-extras/get-script-bytecode.js";
import getScriptHash from "../../../src/tools/volt-extras/get-script-hash.js";
import { voltExtrasTools } from "../../../src/tools/volt-extras/index.js";

/**
 * Minimal ToolContext stub: records each runLuau source + options and returns a
 * canned decoded value. We only assert on the Luau the tool builds and the
 * { data } it returns — no socket, no game.
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

describe("volt-extras tools", () => {
  it("exports all 10 tools with unique names across the assigned categories", () => {
    expect(voltExtrasTools).toHaveLength(10);
    const names = voltExtrasTools.map((t) => t.name);
    expect(new Set(names).size).toBe(10);

    const byName = new Map(voltExtrasTools.map((t) => [t.name, t]));
    expect(byName.get("filter-gc")?.category).toBe("Reverse Engineering");
    expect(byName.get("get-call-stack")?.category).toBe("Reverse Engineering");
    expect(byName.get("get-stack")?.category).toBe("Reverse Engineering");
    expect(byName.get("get-hidden-ui")?.category).toBe("Inspection");
    expect(byName.get("list-rendered-instances")?.category).toBe("Inspection");
    expect(byName.get("cache-invalidate")?.category).toBe("Memory Scan");
    expect(byName.get("cache-is-cached")?.category).toBe("Memory Scan");
    expect(byName.get("cache-replace")?.category).toBe("Memory Scan");
    expect(byName.get("get-script-bytecode")?.category).toBe("Reverse Engineering");
    expect(byName.get("get-script-hash")?.category).toBe("Reverse Engineering");
  });

  it("marks exactly the cache mutators as mutatesState", () => {
    const mutating = voltExtrasTools
      .filter((t) => t.mutatesState === true)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual(["cache-invalidate", "cache-replace"]);
  });

  describe("filter-gc", () => {
    it("guards filtergc, builds the function options table, and caps via limit", async () => {
      const canned = { filterType: "function", matchCount: 1, truncated: false, matches: [] };
      const { ctx, calls } = stubContext(canned);
      const input = filterGc.input.parse({
        filterType: "function",
        options: {
          Name: "attack",
          Constants: ["FireServer", 'say "hi"'],
          Upvalues: [1337, true],
        },
        limit: 25,
        threadContext: 3,
      });

      const result = await filterGc.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      // Capability guard + clean degradation message.
      expect(source).toContain('if type(filtergc) ~= "function" then');
      expect(source).toContain('return { error = "filtergc is not available in this executor." }');
      // filtergc is invoked with the literal filterType and returnOne=false.
      expect(source).toContain('pcall(filtergc, "function", opts, false)');
      // Function criteria are spliced; IgnoreExecutor defaults true when omitted.
      expect(source).toContain('Name = "attack"');
      expect(source).toContain("IgnoreExecutor = true");
      // Strings inside arrays funnel through q() (embedded quotes escaped).
      expect(source).toContain('Constants = { "FireServer", "say \\"hi\\"" }');
      expect(source).toContain("Upvalues = { 1337, true }");
      // limit spliced as the LIMIT cap.
      expect(source).toContain("local LIMIT = 25");
      expect(options?.timeoutMs).toBe(45000);
      expect(options?.threadContext).toBe(3);
    });

    it("builds the table options table with KeyValuePairs and omits function-only fields", async () => {
      const { ctx, calls } = stubContext({});
      const input = filterGc.input.parse({
        filterType: "table",
        options: {
          Keys: ["Coins"],
          KeyValuePairs: { GodMode: true },
        },
      });

      await filterGc.execute(input, ctx);

      const { source } = calls[0]!;
      expect(source).toContain('pcall(filtergc, "table", opts, false)');
      expect(source).toContain('Keys = { "Coins" }');
      expect(source).toContain('KeyValuePairs = { ["GodMode"] = true }');
      // No function-only IgnoreExecutor for a table filter.
      expect(source).not.toContain("IgnoreExecutor");
    });

    it("clamps an out-of-range limit", async () => {
      const { ctx, calls } = stubContext({});
      const input = filterGc.input.parse({
        filterType: "function",
        options: {},
        limit: 9999999,
      });
      await filterGc.execute(input, ctx);
      expect(calls[0]?.source).toContain("local LIMIT = 2000");
    });
  });

  describe("get-call-stack", () => {
    it("guards debug.info, clamps maxLevels, and uses the 15s budget", async () => {
      const canned = { frames: [] };
      const { ctx, calls } = stubContext(canned);
      const input = getCallStack.input.parse({ maxLevels: 9999 });

      const result = await getCallStack.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      expect(source).toContain(
        'return { error = "debug.info is not available in this executor." }',
      );
      // maxLevels clamped to 200.
      expect(source).toContain("local MAX = 200");
      expect(source).toContain('pcall(__info, level, "nsl")');
      expect(options?.timeoutMs).toBe(15000);
    });
  });

  describe("cache-replace", () => {
    it("is a mutator that guards the cache library and q-quotes both paths", async () => {
      expect(cacheReplace.mutatesState).toBe(true);
      const { ctx, calls } = stubContext({ ok: true });
      const input = cacheReplace.input.parse({
        instancePath: "game.Workspace.Boss",
        replacementPath: "game.Workspace.Decoy",
      });

      await cacheReplace.execute(input, ctx);

      const { source, options } = calls[0]!;
      expect(source).toContain('if type(cache) ~= "table" then');
      expect(source).toContain('return { error = "cache is not available in this executor." }');
      expect(source).toContain('if type(cache.replace) ~= "function" then');
      expect(source).toContain('__resolveInstance("game.Workspace.Boss")');
      expect(source).toContain('__resolveInstance("game.Workspace.Decoy")');
      expect(source).toContain("pcall(cache.replace, a, b)");
      expect(options?.timeoutMs).toBe(15000);
    });
  });

  describe("get-script-bytecode", () => {
    it("is read-only, guards getscriptbytecode, resolves the script, and previews hex", async () => {
      expect(getScriptBytecode.mutatesState).toBeFalsy();
      const canned = { byteCount: 128, hexPreview: "abcd" };
      const { ctx, calls } = stubContext(canned);
      const input = getScriptBytecode.input.parse({
        scriptPath: "game.ReplicatedStorage.Module",
        previewBytes: 32,
      });

      const result = await getScriptBytecode.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      expect(source).toContain('if type(getscriptbytecode) ~= "function" then');
      expect(source).toContain(
        'return { error = "getscriptbytecode is not available in this executor." }',
      );
      expect(source).toContain('"return " .. "game.ReplicatedStorage.Module"');
      expect(source).toContain("pcall(getscriptbytecode, script)");
      // previewBytes spliced into the hex loop.
      expect(source).toContain("math.min(#bytecode, 32)");
      expect(source).toContain("byteCount = #bytecode");
      expect(options?.timeoutMs).toBe(20000);
    });

    it("clamps a huge previewBytes value", async () => {
      const { ctx, calls } = stubContext({});
      const input = getScriptBytecode.input.parse({
        scriptPath: "game.A",
        previewBytes: 999999,
      });
      await getScriptBytecode.execute(input, ctx);
      expect(calls[0]?.source).toContain("math.min(#bytecode, 4096)");
    });
  });

  describe("get-script-hash", () => {
    it("is read-only, guards getscripthash, and resolves the script", async () => {
      expect(getScriptHash.mutatesState).toBeFalsy();
      const canned = { hash: "deadbeef" };
      const { ctx, calls } = stubContext(canned);
      const input = getScriptHash.input.parse({ scriptPath: "game.ReplicatedStorage.Module" });

      const result = await getScriptHash.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      expect(source).toContain('if type(getscripthash) ~= "function" then');
      expect(source).toContain(
        'return { error = "getscripthash is not available in this executor." }',
      );
      expect(source).toContain('"return " .. "game.ReplicatedStorage.Module"');
      expect(source).toContain("pcall(getscripthash, script)");
      expect(options?.timeoutMs).toBe(20000);
    });
  });
});
