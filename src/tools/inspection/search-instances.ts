import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "search-instances",
  title: "Search for instances in the game",
  description:
    "Search Roblox instances with QueryDescendants selector syntax. Use for class, name, tag, property, and attribute queries against a chosen root.",
  category: "Inspection",
  input: z.object({
    selector: z
      .string()
      .describe(
        "Selector string to filter instances. Supports classes (Part), tags (.Tagged), names (#HumanoidRootPart), properties ([CanCollide = false]), attributes ([$QuestId] or [$Health = 100]), child/descendant combinators (> and >>), OR selectors (,), :not(), and :has(); chain selectors for AND logic, e.g. Part.Tagged[Anchored = false].",
      ),
    root: z
      .string()
      .describe(
        "The root instance to search from (e.g., 'game.Workspace', 'game.ReplicatedStorage'). Defaults to 'game' if not specified.",
      )
      .optional()
      .default("game"),
    limit: z
      .number()
      .int()
      .describe("Maximum number of results to return (default: 50, to avoid overwhelming output)")
      .optional()
      .default(50),
    threadContext: z.number().int().optional(),
  }),
  async execute({ selector, root, limit, threadContext }, ctx) {
    const safeLimit = Math.max(1, Math.floor(limit));
    const source = `
local limit = ${safeLimit}
local selector = ${q(selector)}

local rootFn, rootErr = loadstring("return " .. ${q(root)})
if not rootFn then
  return { error = "Invalid root expression '" .. ${q(root)} .. "': " .. tostring(rootErr) }
end
local okRoot, rootInstance = pcall(rootFn)
if not okRoot or typeof(rootInstance) ~= "Instance" then
  return { error = "Root path did not resolve to an Instance: " .. ${q(root)} }
end

local okQuery, instances = pcall(function() return rootInstance:QueryDescendants(selector) end)
if not okQuery or type(instances) ~= "table" then
  return { error = "QueryDescendants failed for selector '" .. selector .. "': " .. tostring(instances) }
end

local results = {}
for i, instance in ipairs(instances) do
  if i > limit then break end
  local okFull, full = pcall(function() return instance:GetFullName() end)
  local okDebug, debugId = pcall(function() return instance:GetDebugId() end)
  table.insert(results, {
    Name = instance.Name,
    ClassName = instance.ClassName,
    InstancePath = okFull and full or tostring(instance),
    DebugId = okDebug and debugId or nil,
  })
end

return {
  count = #instances,
  limited = #instances > limit,
  results = results,
}
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
