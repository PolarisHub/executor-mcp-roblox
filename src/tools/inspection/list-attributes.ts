import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "list-attributes",
  title: "List custom attributes used under a root",
  description:
    "Walk the descendants of a root instance and collect every unique custom attribute name (via GetAttributes()), with its observed value type, a sample value, and how many instances carry it. " +
    "Use this when debugging gameplay data that is stored as instance attributes (e.g. QuestId, Health, OwnerUserId) and you want to discover which attribute keys exist in a place without grepping scripts. " +
    "Returns [{ Name, ValueType, SampleValue, InstanceCount }] sorted by frequency. Work is capped at `limit` instances scanned.",
  category: "Inspection",
  input: z.object({
    root: z
      .string()
      .describe(
        "Dotted root path to scan descendants of (e.g. 'game.Workspace', 'game.ReplicatedStorage'). Defaults to 'game' (the whole DataModel). Narrow this to keep scans fast on large places.",
      )
      .optional()
      .default("game"),
    limit: z
      .number()
      .int()
      .describe(
        "Maximum number of instances to scan before stopping (default: 1000). Lower this for a quick sample; raise it for exhaustive coverage at the cost of speed.",
      )
      .optional()
      .default(1000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ root, limit, threadContext }, ctx) {
    const safeLimit = Math.max(1, Math.min(50000, Math.floor(limit)));

    const source = `
local rootPath = ${q(root)}
local limit = ${safeLimit}

local function resolve(p)
  local segments = {}
  for seg in string.gmatch(p, "[^%.]+") do table.insert(segments, seg) end
  if #segments == 0 then return game end
  local first = segments[1]
  local current
  if first == "game" or first == "Game" then
    current = game
  elseif first == "workspace" or first == "Workspace" then
    current = workspace
  else
    local ok, svc = pcall(function() return game:GetService(first) end)
    if ok and svc then current = svc end
  end
  if not current then return nil, "Could not resolve root '" .. tostring(first) .. "'" end
  for i = 2, #segments do
    local name = segments[i]
    local ok, child = pcall(function() return current:FindFirstChild(name) end)
    if ok and child then current = child else
      return nil, "Path segment '" .. tostring(name) .. "' not found"
    end
  end
  return current
end

local rootInst, err = resolve(rootPath)
if not rootInst then return { error = err or "Failed to resolve root" } end

local okDesc, descendants = pcall(function() return rootInst:GetDescendants() end)
if not okDesc then return { error = "GetDescendants failed on root" } end

local attrs = {} -- name -> { ValueType, SampleValue, InstanceCount }
local scanned = 0

local function record(inst)
  local ok, map = pcall(function() return inst:GetAttributes() end)
  if not ok or type(map) ~= "table" then return end
  for name, value in pairs(map) do
    local entry = attrs[name]
    if not entry then
      local sample
      local okS, s = pcall(function() return tostring(value) end)
      sample = okS and s or "<unprintable>"
      attrs[name] = { ValueType = typeof(value), SampleValue = sample, InstanceCount = 1 }
    else
      entry.InstanceCount = entry.InstanceCount + 1
    end
  end
end

-- Include the root itself, then descendants up to the scan cap.
record(rootInst)
scanned = scanned + 1
for _, inst in ipairs(descendants) do
  if scanned >= limit then break end
  scanned = scanned + 1
  record(inst)
end

local results = {}
for name, entry in pairs(attrs) do
  table.insert(results, {
    Name = name,
    ValueType = entry.ValueType,
    SampleValue = entry.SampleValue,
    InstanceCount = entry.InstanceCount,
  })
end
table.sort(results, function(a, b) return a.InstanceCount > b.InstanceCount end)

return {
  Root = rootPath,
  ScannedInstances = scanned,
  Truncated = scanned >= limit,
  UniqueAttributes = #results,
  Attributes = results,
}`;

    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
