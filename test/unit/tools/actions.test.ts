import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import setInstanceProperty from "../../../src/tools/actions/set-instance-property.js";
import setPropertiesBulk from "../../../src/tools/actions/set-properties-bulk.js";
import dumpTable from "../../../src/tools/actions/dump-table.js";
import { actionsTools } from "../../../src/tools/actions/index.js";

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

describe("actions tools", () => {
  it("exports all 10 tools with unique names in the Actions category", () => {
    expect(actionsTools).toHaveLength(10);
    const names = actionsTools.map((t) => t.name);
    expect(new Set(names).size).toBe(10);
    for (const tool of actionsTools) {
      expect(tool.category).toBe("Actions");
    }
  });

  it("marks exactly the eight write/act tools as mutatesState; the two readers are read-only", () => {
    const mutating = actionsTools
      .filter((t) => t.mutatesState === true)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual(
      [
        "set-instance-property",
        "set-attribute",
        "set-properties-bulk",
        "create-instance",
        "clone-instance",
        "destroy-instance",
        "invoke-method",
        "fire-remote",
      ].sort(),
    );

    const readOnly = actionsTools
      .filter((t) => t.mutatesState !== true)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual(["dump-table", "get-thread-stack"].sort());
  });

  describe("set-instance-property", () => {
    it("evaluates the instance, reads old/new, and splices a boolean value literal", async () => {
      const canned = { Path: "Workspace.Part", Property: "Anchored", ok: true } as const;
      const { ctx, calls } = stubContext(canned);
      const input = setInstanceProperty.input.parse({
        instancePath: "game.Workspace.Part",
        propertyName: "Anchored",
        value: { kind: "boolean", value: true },
      });

      const result = await setInstanceProperty.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      expect(source).toContain('local inst, err = __eval("game.Workspace.Part")');
      expect(source).toContain('local prop = "Anchored"');
      // boolean value built by buildValueExpr -> literal `true`.
      expect(source).toContain("inst[prop] = true");
      // 20s budget; threadContext undefined by default.
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBeUndefined();
    });

    it("passes threadContext through to runLuau when supplied", async () => {
      const { ctx, calls } = stubContext({});
      const input = setInstanceProperty.input.parse({
        instancePath: "game.Workspace.Part",
        propertyName: "Transparency",
        value: { kind: "number", value: 0.5 },
        threadContext: 7,
      });

      await setInstanceProperty.execute(input, ctx);

      expect(calls[0]?.options?.threadContext).toBe(7);
      // raw number literal, not quoted.
      expect(calls[0]?.source).toContain("inst[prop] = 0.5");
    });

    it("is a state-mutating tool", () => {
      expect(setInstanceProperty.mutatesState).toBe(true);
    });
  });

  describe("set-properties-bulk", () => {
    it("emits one do-block per property with the correct value expressions", async () => {
      const canned = { Path: "Workspace.Part", okCount: 2, failCount: 0 };
      const { ctx, calls } = stubContext(canned);
      const input = setPropertiesBulk.input.parse({
        instancePath: "game.Workspace.Part",
        properties: [
          { name: "Anchored", value: { kind: "boolean", value: true } },
          { name: "Size", value: { kind: "raw", value: "Vector3.new(4,1,4)" } },
        ],
      });

      const result = await setPropertiesBulk.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source } = calls[0]!;
      expect(source).toContain('local pname = "Anchored"');
      expect(source).toContain("inst[pname] = true");
      expect(source).toContain('local pname = "Size"');
      // raw kind wraps the expression in a loadstring resolver.
      expect(source).toContain('(loadstring("return " .. "Vector3.new(4,1,4)"))()');
    });
  });

  describe("dump-table", () => {
    it("defaults maxDepth/maxKeys and resolves the table expression", async () => {
      const canned = { Target: "getgenv()", Depth: 2, Table: {}, Truncated: false };
      const { ctx, calls } = stubContext(canned);
      const input = dumpTable.input.parse({ tablePath: "getgenv()" });

      const result = await dumpTable.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      expect(source).toContain("local __maxDepth = 2");
      expect(source).toContain("local __maxKeys = 100");
      expect(source).toContain('local target, err = __eval("getgenv()")');
      expect(options?.timeoutMs).toBe(20000);
    });

    it("is read-only (does not set mutatesState)", () => {
      expect(dumpTable.mutatesState ?? false).toBe(false);
    });
  });
});
