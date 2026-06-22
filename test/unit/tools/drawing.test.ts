import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import drawCreate from "../../../src/tools/drawing/draw-create.js";
import drawUpdate from "../../../src/tools/drawing/draw-update.js";
import drawRemove from "../../../src/tools/drawing/draw-remove.js";
import listDrawings from "../../../src/tools/drawing/list-drawings.js";
import { drawingTools } from "../../../src/tools/drawing/index.js";

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

describe("drawing tools", () => {
  it("exports all 5 tools with unique names in the Drawing category", () => {
    expect(drawingTools).toHaveLength(5);
    const names = drawingTools.map((t) => t.name);
    expect(new Set(names).size).toBe(5);
    for (const tool of drawingTools) {
      expect(tool.category).toBe("Drawing");
    }
  });

  it("marks every tool except list-drawings as mutatesState", () => {
    const mutating = drawingTools
      .filter((t) => t.mutatesState === true)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual(["draw-clear", "draw-create", "draw-remove", "draw-update"].sort());

    const readOnly = drawingTools.filter((t) => t.mutatesState !== true).map((t) => t.name);
    expect(readOnly).toEqual(["list-drawings"]);
  });

  describe("draw-create", () => {
    it("guards Drawing, seeds the registry, calls Drawing.new, and resolves prop exprs via loadstring", async () => {
      const canned = { id: 1, type: "Line", applied: [] };
      const { ctx, calls } = stubContext(canned);
      const input = drawCreate.input.parse({
        type: "Line",
        properties: {
          Color: "Color3.new(1,0,0)",
          From: "Vector2.new(10,10)",
          Visible: "true",
        },
        threadContext: 4,
      });

      const result = await drawCreate.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(drawCreate.mutatesState).toBe(true);
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      // Capability guard + registry bootstrap.
      expect(source).toContain('if type(Drawing) ~= "table" then');
      expect(source).toContain("genv.__mcp_drawings");
      expect(source).toContain("genv.__mcp_drawings_counter");
      expect(source).toContain('pcall(Drawing.new, "Line")');
      // Each property expression is quoted and compiled via loadstring/load.
      expect(source).toContain('"return " .. "Color3.new(1,0,0)"');
      expect(source).toContain('"return " .. "Vector2.new(10,10)"');
      expect(source).toContain('obj["Color"] = __v');
      expect(source).toContain('obj["Visible"] = __v');
      expect(options?.threadContext).toBe(4);
      expect(options?.timeoutMs).toBe(15000);
    });

    it("defaults properties to an empty map (no apply blocks)", async () => {
      const { ctx, calls } = stubContext({});
      const input = drawCreate.input.parse({ type: "Text" });
      await drawCreate.execute(input, ctx);
      const { source } = calls[0]!;
      expect(source).toContain('pcall(Drawing.new, "Text")');
      expect(source).not.toContain("obj[");
    });
  });

  describe("draw-update", () => {
    it("looks the handle up by id and assigns each property", async () => {
      const canned = { id: 7, updated: [] };
      const { ctx, calls } = stubContext(canned);
      const input = drawUpdate.input.parse({
        id: 7,
        properties: { To: "Vector2.new(400,300)", Visible: "false" },
      });

      const result = await drawUpdate.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(drawUpdate.mutatesState).toBe(true);
      const { source } = calls[0]!;
      expect(source).toContain('if type(Drawing) ~= "table" then');
      expect(source).toContain("local id = 7");
      expect(source).toContain("local entry = registry[id]");
      expect(source).toContain('obj["To"] = __v');
      expect(source).toContain('obj["Visible"] = __v');
      expect(source).toContain('"return " .. "Vector2.new(400,300)"');
    });
  });

  describe("draw-remove", () => {
    it("floors the id, calls handle:Remove(), and clears the registry slot", async () => {
      const canned = { id: 3, removed: true };
      const { ctx, calls } = stubContext(canned);
      const input = drawRemove.input.parse({ id: 3 });

      const result = await drawRemove.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(drawRemove.mutatesState).toBe(true);
      const { source } = calls[0]!;
      expect(source).toContain("local id = 3");
      expect(source).toContain("entry.handle:Remove()");
      expect(source).toContain("registry[id] = nil");
    });
  });

  describe("list-drawings", () => {
    it("is read-only, clamps the limit, and reads each handle's Visible property", async () => {
      const canned = { count: 0, truncated: false, drawings: [] };
      const { ctx, calls } = stubContext(canned);
      const input = listDrawings.input.parse({ limit: 999999 });

      const result = await listDrawings.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(listDrawings.mutatesState).not.toBe(true);
      const { source, options } = calls[0]!;
      // 999999 clamps to the 5000 ceiling.
      expect(source).toContain("if #drawings < 5000 then");
      expect(source).toContain("return entry.handle.Visible");
      expect(source).toContain("type = entry.type");
      expect(options?.timeoutMs).toBe(15000);
    });
  });
});
