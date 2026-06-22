import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import findTablesByKey from "../../../src/tools/memory-scan/find-tables-by-key.js";
import writePathValue from "../../../src/tools/memory-scan/write-path-value.js";
import watchValue from "../../../src/tools/memory-scan/watch-value.js";
import { memoryScanTools } from "../../../src/tools/memory-scan/index.js";

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

describe("memory-scan tools", () => {
  it("exports all 8 tools with unique names in the Memory Scan category", () => {
    expect(memoryScanTools).toHaveLength(8);
    const names = memoryScanTools.map((t) => t.name);
    expect(new Set(names).size).toBe(8);
    for (const tool of memoryScanTools) {
      expect(tool.category).toBe("Memory Scan");
    }
  });

  it("marks only write-path-value as mutatesState; the rest are read-only scans", () => {
    const mutating = memoryScanTools
      .filter((t) => t.mutatesState === true)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual(["write-path-value"]);

    const readOnly = memoryScanTools
      .filter((t) => t.mutatesState !== true)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual(
      [
        "find-tables-by-key",
        "scan-number-range",
        "read-path-value",
        "find-table-references",
        "find-string-in-tables",
        "search-gc-value",
        "watch-value",
      ].sort(),
    );
  });

  describe("find-tables-by-key", () => {
    it("q-quotes the needle, clamps limit/maxScan, and runs on the 45s GC budget", async () => {
      const canned = { matchCount: 1, scannedObjects: 10, truncated: false, matches: [] };
      const { ctx, calls } = stubContext(canned);
      const input = findTablesByKey.input.parse({
        key: "Coins",
        contains: true,
        // out-of-range values: limit clamps to 1, maxScan clamps to 200000
        limit: 0,
        maxScan: 9999999,
      });

      const result = await findTablesByKey.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      expect(source).toContain('local needle = "Coins"');
      expect(source).toContain("local useContains = true");
      // limit clamped to 1 -> emitted both as the < cap and the >= cap guards
      expect(source).toContain("if #matches < 1 then");
      expect(source).toContain("if #matches >= 1 then break end");
      // maxScan clamped to 200000
      expect(source).toContain("if scanned > 200000 then truncated = true break end");
      // GC scans carry the 45s budget; threadContext undefined by default.
      expect(options?.timeoutMs).toBe(45000);
      expect(options?.threadContext).toBeUndefined();
    });

    it("defaults contains to false (exact match)", async () => {
      const { ctx, calls } = stubContext({});
      const input = findTablesByKey.input.parse({ key: "Health" });
      await findTablesByKey.execute(input, ctx);
      expect(calls[0]?.source).toContain("local useContains = false");
    });
  });

  describe("write-path-value", () => {
    it("is a state-mutating tool", () => {
      expect(writePathValue.mutatesState).toBe(true);
    });

    it("resolves the container, splices a boolean value literal, and uses the 20s budget", async () => {
      const canned = {
        Container: "table: 0x1",
        Key: "GodMode",
        OldValue: false,
        NewValue: true,
        ok: true,
      };
      const { ctx, calls } = stubContext(canned);
      const input = writePathValue.input.parse({
        containerExpr: "require(game.ReplicatedStorage.Config)",
        key: "GodMode",
        value: { kind: "boolean", value: true },
        threadContext: 2,
      });

      const result = await writePathValue.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      expect(source).toContain(
        'local container, err = __eval("require(game.ReplicatedStorage.Config)")',
      );
      expect(source).toContain('local key = "GodMode"');
      // boolean value built by buildValueExpr -> literal `true`.
      expect(source).toContain("container[key] = true");
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBe(2);
    });

    it("wraps a raw value expression in a loadstring resolver", async () => {
      const { ctx, calls } = stubContext({});
      const input = writePathValue.input.parse({
        containerExpr: "getgenv().PlayerData",
        key: "Spawn",
        value: { kind: "raw", value: "Vector3.new(0,50,0)" },
      });
      await writePathValue.execute(input, ctx);
      expect(calls[0]?.source).toContain(
        'container[key] = (loadstring("return " .. "Vector3.new(0,50,0)"))()',
      );
    });
  });

  describe("watch-value", () => {
    it("clamps interval/duration and sets the network timeout to duration + 10000", async () => {
      const canned = {
        expression: "x",
        sampleCount: 0,
        changeCount: 0,
        truncated: false,
        samples: [],
      };
      const { ctx, calls } = stubContext(canned);
      const input = watchValue.input.parse({
        expression: "getgenv().speed",
        // out-of-range: interval clamps to 5000, duration clamps to 30000
        intervalMs: 999999,
        durationMs: 999999,
      });

      const result = await watchValue.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      expect(source).toContain('local expression = "getgenv().speed"');
      expect(source).toContain("local intervalSec = 5000 / 1000");
      expect(source).toContain("local durationSec = 30000 / 1000");
      // timeout = clamped duration (30000) + 10000 buffer
      expect(options?.timeoutMs).toBe(40000);
    });
  });
});
