import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "build-call-graph",
  title: "Build call graph / function tree (IDA call graph)",
  description:
    "Build an IDA-style call graph (function tree) rooted at a target Luau function. Each Luau function carries its " +
    "nested protos — the functions it can construct and call — so this recurses through getprotos breadth-first to map " +
    "the callee tree. Returns a FLATTENED node list (each node knows its parentIndex and depth) so you can reconstruct " +
    "the tree, plus per-node proto/upvalue counts and source/line from debug.info. Use it to understand how a closure " +
    "fans out into helpers, spot deeply nested logic, and pick disassembly targets. Resolve the root via a Luau " +
    'expression (e.g. "getrenv().game.PlayerScripts.Main.someFunc" or a global). Requires getprotos; caps depth and ' +
    "node count.",
  category: "Disassembly & Xrefs",
  input: z.object({
    functionPath: z
      .string()
      .describe(
        'Luau expression that resolves to the ROOT function (e.g. "getgenv().myFunc" or ' +
          '"require(game.ReplicatedStorage.Mod).start"). Evaluated as `return <expr>`; must yield a function.',
      ),
    maxDepth: z
      .number()
      .int()
      .describe(
        "How many proto levels deep to recurse from the root (default 3, max 6). Root is depth 0.",
      )
      .optional()
      .default(3),
    maxNodes: z
      .number()
      .int()
      .describe(
        "Hard cap on total nodes (including the root) to keep the graph bounded (default 120).",
      )
      .optional()
      .default(120),
    threadContext: z.number().int().optional(),
  }),
  async execute({ functionPath, maxDepth, maxNodes, threadContext }, ctx) {
    const depthCap = Math.min(Math.max(Math.floor(maxDepth), 0), 6);
    const nodeCap = Math.min(Math.max(Math.floor(maxNodes), 1), 2000);
    const source = `
${XREF_PRELUDE}
local ok, root = pcall(function() return (loadstring("return " .. ${q(functionPath)}))() end)
if not ok or type(root) ~= "function" then
  return { error = "functionPath did not resolve to a function: " .. ${q(functionPath)} }
end

local maxDepth = ${depthCap}
local maxNodes = ${nodeCap}
local graph = {}
local truncated = false

-- Node holds the actual function plus tree metadata; we emit a sanitized copy.
local nodes = { { fn = root, parentIndex = -1, depth = 0 } }
local head = 1
while head <= #nodes do
  local node = nodes[head]
  local fn = node.fn
  local info = __fnInfo(fn)
  local protos = __protos(fn)
  local ups = __ups(fn)
  graph[#graph + 1] = {
    index = head,
    parentIndex = node.parentIndex,
    depth = node.depth,
    name = info.name,
    source = info.source,
    line = info.line,
    protoCount = #protos,
    upvalueCount = #ups,
  }
  if node.depth < maxDepth then
    for _, child in protos do
      if type(child) == "function" then
        if #nodes >= maxNodes then truncated = true break end
        nodes[#nodes + 1] = { fn = child, parentIndex = head, depth = node.depth + 1 }
      end
    end
  end
  head = head + 1
end

return { root = __fnInfo(root), nodeCount = #graph, truncated = truncated, graph = graph }
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
