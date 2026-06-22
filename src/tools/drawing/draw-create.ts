import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/** The seven Drawing object types the executor `Drawing` library supports. */
const DRAWING_TYPES = ["Line", "Text", "Circle", "Square", "Quad", "Triangle", "Image"] as const;

/**
 * Build a Luau snippet that resolves one property value into a Lua value. Each
 * value arrives as a STRING that is a Luau expression — primitives are emitted
 * inline, anything richer (Color3/Vector2/UDim2/…) is compiled through loadstring
 * so it evaluates in the game environment. The result is left in a local `__v`.
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
  name: "draw-create",
  title: "Create a Drawing object (ESP/debug overlay)",
  description:
    "Creates a new on-screen overlay object via the executor `Drawing` library (used for ESP boxes, tracers, " +
    "name tags, and debug HUDs) and registers it so it survives across tool calls. Calls Drawing.new(type) for " +
    "type in {Line, Text, Circle, Square, Quad, Triangle, Image}, applies the given properties, stores the handle " +
    "in getgenv().__mcp_drawings under a new integer id, and returns { id, type } — pass that id to draw-update / " +
    "draw-remove. " +
    "PROPERTIES: each property value is a Luau EXPRESSION STRING evaluated via loadstring, so rich types work: " +
    "Color = 'Color3.new(1,0,0)', From = 'Vector2.new(10,10)', To = 'Vector2.new(200,200)', Position = " +
    "'Vector2.new(100,100)', Visible = 'true', Thickness = '2', Text = '\"hello\"', Size = '18'. Common props: " +
    "Visible(bool), Color(Color3), Transparency(number 0..1), ZIndex(number). Per type — Line: From, To, Thickness; " +
    "Text: Text, Size, Position, Center, Outline; Circle: Center, Radius, NumSides, Thickness, Filled; Square: Size, " +
    "Position, Thickness, Filled. " +
    "Requires the `Drawing` table (type-guarded); on an executor without it, it returns " +
    '{ error = "Drawing is not available in this executor." }. Every call is pcall-guarded. ' +
    "Returns { id, type, applied[] } or { error }.",
  category: "Drawing",
  mutatesState: true,
  input: z.object({
    type: z
      .enum(DRAWING_TYPES)
      .describe(
        "The Drawing object type to create via Drawing.new(type): one of Line, Text, Circle, Square, Quad, " +
          "Triangle, Image.",
      ),
    properties: z
      .record(z.string(), z.unknown())
      .describe(
        "Map of property name -> Luau expression STRING to assign after creation. Values are evaluated via " +
          "loadstring, so use Luau syntax: Color = 'Color3.new(1,0,0)', From = 'Vector2.new(10,10)', " +
          "Visible = 'true', Thickness = '2', Text = '\"label\"'. Unknown/failed properties are reported in " +
          "'applied' with ok=false but do not abort the create.",
      )
      .optional()
      .default({}),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ type, properties, threadContext, timeoutMs }, ctx) {
    const props = properties ?? {};
    const applyBlocks = Object.entries(props)
      .map(([name, value]) => {
        const expr = typeof value === "string" ? value : String(value);
        return `
  do
    ${valueResolver(expr)}
    if __ok then
      local __okSet = pcall(function() obj[${q(name)}] = __v end)
      applied[#applied + 1] = { name = ${q(name)}, ok = __okSet }
    else
      applied[#applied + 1] = { name = ${q(name)}, ok = false, error = tostring(__v) }
    end
  end`;
      })
      .join("\n");

    const source = `
if type(Drawing) ~= "table" then return { error = "Drawing is not available in this executor." } end
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor." } end

local genv = getgenv()
if type(genv.__mcp_drawings) ~= "table" then genv.__mcp_drawings = {} end
if type(genv.__mcp_drawings_counter) ~= "number" then genv.__mcp_drawings_counter = 0 end
local registry = genv.__mcp_drawings

local okNew, obj = pcall(Drawing.new, ${q(type)})
if not okNew or obj == nil then
  return { error = "Drawing.new(${type}) failed: " .. tostring(obj) }
end

local applied = {}
${applyBlocks}

genv.__mcp_drawings_counter = genv.__mcp_drawings_counter + 1
local id = genv.__mcp_drawings_counter
registry[id] = { handle = obj, type = ${q(type)} }

return { id = id, type = ${q(type)}, applied = applied }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
