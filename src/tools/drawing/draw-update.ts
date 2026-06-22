import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Build a Luau snippet that resolves one property value (a Luau expression
 * STRING) into a Lua value left in local `__v`, compiling via loadstring so
 * rich types (Color3/Vector2/…) evaluate in the game environment.
 */
function valueResolver(expr: string): string {
  return `
    local __ok, __v = pcall(function()
      local __loader = loadstring or load
      if type(__loader) ~= "function" then error("loadstring/load is not available in this executor.") end
      local __chunk = __loader("return " .. ${q(expr)})
      if type(__chunk) ~= "function" then error("could not compile property expression") end
      return __chunk()
    end)`;
}

export default defineTool({
  name: "draw-update",
  title: "Update properties of an existing Drawing object",
  description:
    "Mutates a Drawing overlay previously created by draw-create, looking the handle up by its integer id in " +
    "getgenv().__mcp_drawings and assigning each given property. Use it to move a tracer (To = " +
    "'Vector2.new(400,300)'), recolor an ESP box (Color = 'Color3.new(0,1,0)'), toggle visibility " +
    "(Visible = 'false'), or change a label (Text = '\"BOSS\"'). " +
    "PROPERTIES: each value is a Luau EXPRESSION STRING evaluated via loadstring, identical to draw-create. " +
    "Unknown/failed properties are reported per-property in 'updated' (ok=false) without aborting the rest. " +
    "Requires the `Drawing` table (type-guarded). If the id is unknown it returns " +
    '{ error }; on an executor without it, it returns { error = "Drawing is not available in this executor." }. ' +
    "Returns { id, updated[] } or { error }.",
  category: "Drawing",
  mutatesState: true,
  input: z.object({
    id: z
      .number()
      .int()
      .describe("Integer id of the Drawing object (as returned by draw-create / list-drawings)."),
    properties: z
      .record(z.string(), z.unknown())
      .describe(
        "Map of property name -> Luau expression STRING to assign. Values are evaluated via loadstring, so use " +
          "Luau syntax: Color = 'Color3.new(0,1,0)', To = 'Vector2.new(400,300)', Visible = 'false', " +
          "Text = '\"label\"'. Failed properties are reported in 'updated' with ok=false.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ id, properties, threadContext, timeoutMs }, ctx) {
    const applyBlocks = Object.entries(properties)
      .map(([name, value]) => {
        const expr = typeof value === "string" ? value : String(value);
        return `
  do
    ${valueResolver(expr)}
    if __ok then
      local __okSet, __setErr = pcall(function() obj[${q(name)}] = __v end)
      if __okSet then
        updated[#updated + 1] = { name = ${q(name)}, ok = true }
      else
        updated[#updated + 1] = { name = ${q(name)}, ok = false, error = tostring(__setErr) }
      end
    else
      updated[#updated + 1] = { name = ${q(name)}, ok = false, error = tostring(__v) }
    end
  end`;
      })
      .join("\n");

    const source = `
if type(Drawing) ~= "table" then return { error = "Drawing is not available in this executor." } end
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor." } end

local genv = getgenv()
local registry = genv.__mcp_drawings
if type(registry) ~= "table" then return { error = "No drawings have been created (registry is empty)." } end

local id = ${Math.floor(id)}
local entry = registry[id]
if entry == nil or entry.handle == nil then
  return { error = "No drawing registered with id " .. tostring(id) .. "." }
end
local obj = entry.handle

local updated = {}
${applyBlocks}

return { id = id, updated = updated }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
