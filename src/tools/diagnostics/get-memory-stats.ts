import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "get-memory-stats",
  title: "Lua memory + GC object census (by type)",
  description:
    "In-game memory health probe. Reports the Lua VM's current heap usage via gcinfo() (in KB, guarded) and takes a " +
    "census of the garbage collector by walking getgc(true) and counting objects by type — function, table, thread, " +
    "userdata, and other. Optionally adds engine-level memory from game:GetService('Stats') (GetTotalMemoryUsageMb and " +
    "a few notable categories) when available. " +
    "Use this to gauge how heavy the client is, to spot a runaway table/closure leak (an unusually large gcObjectCount " +
    "or byType.table), or to take a baseline before/after running an exploit. " +
    "The GC walk is capped (maxScan, default 200000) and sets truncated=true if it hits the cap. Requires getgc for the " +
    "census (reports gcObjectCount=nil if absent); gcinfo and Stats are optional. " +
    "Returns { luaMemoryKB, gcObjectCount, truncated, byType, engineMemory } or { error }.",
  category: "Diagnostics",
  input: z.object({
    maxScan: z
      .number()
      .int()
      .describe(
        "Maximum number of GC objects to visit during the census (default 200000). The walk stops at this cap and sets " +
          "truncated=true; raise it on a very large game if you need an exact count, lower it to bound cost.",
      )
      .optional()
      .default(200000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ maxScan, threadContext }, ctx) {
    const cap = Math.min(Math.max(Math.floor(maxScan ?? 200000), 1000), 2000000);

    const source = `
local out = { luaMemoryKB = nil, gcObjectCount = nil, truncated = false, byType = nil, engineMemory = nil }

-- Lua heap size in KB.
if type(gcinfo) == "function" then
  local ok, kb = pcall(gcinfo)
  if ok and type(kb) == "number" then out.luaMemoryKB = kb end
elseif type(collectgarbage) == "function" then
  local ok, kb = pcall(collectgarbage, "count")
  if ok and type(kb) == "number" then out.luaMemoryKB = kb end
end

-- GC census by type.
if type(getgc) ~= "function" then
  out.byType = nil
  out.gcObjectCount = nil
else
  local ok, gc = pcall(getgc, true)
  if not ok or type(gc) ~= "table" then
    ok, gc = pcall(getgc)
  end
  if ok and type(gc) == "table" then
    local counts = { ["function"] = 0, table = 0, thread = 0, userdata = 0, other = 0 }
    local total = 0
    for _, o in gc do
      total = total + 1
      if total > ${cap} then out.truncated = true; break end
      local t = type(o)
      if t == "function" then counts["function"] = counts["function"] + 1
      elseif t == "table" then counts.table = counts.table + 1
      elseif t == "thread" then counts.thread = counts.thread + 1
      elseif t == "userdata" then counts.userdata = counts.userdata + 1
      else counts.other = counts.other + 1 end
    end
    out.gcObjectCount = total
    out.byType = counts
  end
end

-- Engine-level memory (best-effort).
local okStats, stats = pcall(function() return game:GetService("Stats") end)
if okStats and stats then
  local mem = {}
  local okTot, tot = pcall(function() return stats:GetTotalMemoryUsageMb() end)
  if okTot and type(tot) == "number" then mem.totalMemoryMB = tot end
  -- A couple of commonly-present numeric stat items.
  local function __statValue(name)
    local okS, item = pcall(function() return stats[name] end)
    if okS and item then
      local okV, v = pcall(function() return item:GetValue() end)
      if okV and type(v) == "number" then return v end
    end
    return nil
  end
  local instMem = __statValue("InstanceCount")
  if instMem ~= nil then mem.instanceCount = instMem end
  if next(mem) ~= nil then out.engineMemory = mem end
end

out.ok = true
return out
`;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
