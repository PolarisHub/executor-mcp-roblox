import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "get-instance-counts",
  title: "Game-size profile: instance counts by ClassName",
  description:
    "In-game shape/size profile. Walks game:GetDescendants() once (pcall-guarded, capped) and tallies every Instance by " +
    "its ClassName, returning the heaviest classes first. This is the quickest way to understand how big and how " +
    "'shaped' a place is — e.g. tens of thousands of Parts, a forest of UI Frames, a swarm of scripts, or an unusual " +
    "pile of a single odd class. " +
    "The descendant walk is capped (maxScan, default 200000) and sets truncated=true if it hits the cap (the counts " +
    "then reflect only what was scanned). The returned class list is capped to topN entries. " +
    "Requires nothing beyond a live game; everything is guarded. " +
    "Returns { totalInstances, scanned, truncated, distinctClasses, topClasses: [{ class, count }] } (sorted by count " +
    "desc) or { error }.",
  category: "Diagnostics",
  input: z.object({
    topN: z
      .number()
      .int()
      .describe(
        "How many of the heaviest ClassName buckets to return, sorted by count descending (default 25). The full " +
          "distinctClasses count is always reported even when the list is trimmed to topN.",
      )
      .optional()
      .default(25),
    maxScan: z
      .number()
      .int()
      .describe(
        "Maximum number of descendants to visit (default 200000). The walk stops at this cap and sets truncated=true; " +
          "raise it for a huge place if you need exact totals, lower it to bound cost.",
      )
      .optional()
      .default(200000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ topN, maxScan, threadContext }, ctx) {
    const n = Math.min(Math.max(Math.floor(topN ?? 25), 1), 500);
    const cap = Math.min(Math.max(Math.floor(maxScan ?? 200000), 1000), 2000000);

    const source = `
local okDesc, descendants = pcall(function() return game:GetDescendants() end)
if not okDesc or type(descendants) ~= "table" then
  return { error = "Failed to enumerate game:GetDescendants()." }
end

local counts = {}
local distinct = 0
local scanned = 0
local truncated = false
for i = 1, #descendants do
  scanned = scanned + 1
  if scanned > ${cap} then truncated = true; scanned = scanned - 1; break end
  local inst = descendants[i]
  local okC, cls = pcall(function() return inst.ClassName end)
  if okC and type(cls) == "string" then
    if counts[cls] == nil then counts[cls] = 0; distinct = distinct + 1 end
    counts[cls] = counts[cls] + 1
  else
    counts["<unknown>"] = (counts["<unknown>"] or 0) + 1
  end
end

-- Sort classes by count descending.
local arr = {}
for cls, c in pairs(counts) do arr[#arr + 1] = { class = cls, count = c } end
table.sort(arr, function(a, b) return a.count > b.count end)

local top = {}
for i = 1, math.min(#arr, ${n}) do top[i] = arr[i] end

return {
  totalInstances = scanned,
  scanned = scanned,
  truncated = truncated,
  distinctClasses = distinct,
  topClasses = top,
  ok = true,
}
`;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
