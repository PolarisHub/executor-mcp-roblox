import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, RESOLVE_PRELUDE } from "../_shared/luau.js";

export default defineTool({
  name: "get-instance-tree",
  title: "Walk a depth-limited instance hierarchy",
  description:
    "Return a nested { name, class, children } tree under an instance resolved from a dotted path (default 'game'), " +
    "capped by maxDepth and maxChildren so large containers don't overwhelm the output. Each node lists how many " +
    "children were truncated. Use this for broad structure exploration; use get-instance-properties to read one " +
    "instance's values. The path is pcall-resolved, so a bad path returns { error } rather than failing.",
  category: "Inspection",
  input: z.object({
    path: z
      .string()
      .min(1)
      .default("game")
      .describe("Dotted path to the root instance (e.g. 'game.Workspace')."),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(3)
      .describe("Maximum traversal depth (1-20, default 3)."),
    maxChildren: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe("Maximum children shown per node (1-500, default 50)."),
  }),
  async execute({ path, maxDepth, maxChildren }, ctx) {
    const source = `
${RESOLVE_PRELUDE}
local MAX_DEPTH = ${maxDepth}
local MAX_CHILDREN = ${maxChildren}

local root, err = __resolve(${q(path)})
if not root then
  return { error = err or "Failed to resolve path", path = ${q(path)} }
end

local function build(inst, depth)
  local node = { name = inst.Name, class = inst.ClassName }
  if depth >= MAX_DEPTH then
    local ok, kids = pcall(function() return inst:GetChildren() end)
    if ok and #kids > 0 then node.truncatedChildren = #kids end
    return node
  end
  local ok, kids = pcall(function() return inst:GetChildren() end)
  if not ok or #kids == 0 then return node end
  local children = {}
  local shown = math.min(#kids, MAX_CHILDREN)
  for i = 1, shown do
    children[#children + 1] = build(kids[i], depth + 1)
  end
  node.children = children
  if #kids > shown then node.truncatedChildren = #kids - shown end
  return node
end

return { tree = build(root, 0), ok = true }
`;
    const result = (await ctx.runLuau(source)) as {
      error?: string;
      tree?: { name?: string; class?: string };
    };
    if (result?.error) {
      return { data: result, summary: result.error, isError: true };
    }
    return {
      data: result,
      summary: result?.tree ? `${result.tree.name} (${result.tree.class})` : undefined,
    };
  },
});
