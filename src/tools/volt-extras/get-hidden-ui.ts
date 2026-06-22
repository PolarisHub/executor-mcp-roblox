import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "get-hidden-ui",
  title: "gethui — inspect the executor's hidden protected UI container (Volt)",
  description:
    "Return a shallow tree of the executor's hidden, protected GUI container via gethui(). This is the parent that " +
    "executors hand back for ScreenGuis they want kept away from CoreGui/PlayerGui and shielded from the game's " +
    "anti-cheat — the usual home of cheat menus, ESP layers, and overlays. The tool walks gethui():GetChildren() and " +
    "returns a { name, class, children } tree capped at depth 3 with a per-node child cap, reporting how many " +
    "children were truncated. " +
    "Requires gethui (Volt-class executors) — type-guarded and pcall-wrapped, returning { error } when missing or on " +
    "failure. Returns { root: { name, class, childCount, children } } or { error }.",
  category: "Inspection",
  input: z.object({
    maxChildren: z
      .number()
      .int()
      .default(50)
      .describe(
        "Maximum children shown per node (default 50). Extra children are counted in truncatedChildren.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ maxChildren, threadContext, timeoutMs }, ctx) {
    const maxKids = Math.min(Math.max(Math.floor(maxChildren), 1), 500);

    const source = `
if type(gethui) ~= "function" then
  return { error = "gethui is not available in this executor." }
end

local okHui, hui = pcall(gethui)
if not okHui or hui == nil then
  return { error = "gethui failed: " .. tostring(hui) }
end

local MAX_DEPTH = 3
local MAX_CHILDREN = ${maxKids}

local function build(inst, depth)
  local node = {}
  pcall(function() node.name = inst.Name end)
  pcall(function() node.class = inst.ClassName end)

  local ok, kids = pcall(function() return inst:GetChildren() end)
  if not ok or type(kids) ~= "table" then
    return node
  end
  node.childCount = #kids
  if depth >= MAX_DEPTH then
    if #kids > 0 then node.truncatedChildren = #kids end
    return node
  end
  local shown = math.min(#kids, MAX_CHILDREN)
  local children = {}
  for i = 1, shown do
    children[#children + 1] = build(kids[i], depth + 1)
  end
  node.children = children
  if #kids > shown then node.truncatedChildren = #kids - shown end
  return node
end

return { root = build(hui, 0) }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
