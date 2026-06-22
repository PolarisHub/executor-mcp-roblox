import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { HIDDEN_PRELUDE } from "../_shared/hidden.js";

export default defineTool({
  name: "summarize-hidden-surfaces",
  title: "Summarize hidden surfaces (what is hiding)",
  description:
    "One-call high-level overview answering 'what is hiding in this game?'. Safely (each executor call guarded + " +
    "pcall'd) counts: Actors (parallel-Luau VMs), nil-parented instances (with a small top-classes breakdown), " +
    "currently-running scripts, loaded modules, and a quick count of scripts that are NOT sitting normally in the tree " +
    "(hiddenScripts). Any executor function that is unavailable in this executor is listed under `unavailable` instead " +
    "of aborting the whole summary. Use this first to decide which deeper hidden-* tool to run next.",
  category: "Actors & Hidden",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
${HIDDEN_PRELUDE}
local unavailable = {}

-- Generic guarded counter: returns count or nil (and records unavailability).
local function safeCount(fnName, fn)
  if type(fn) ~= "function" then
    unavailable[#unavailable + 1] = fnName
    return nil
  end
  local ok, res = pcall(fn)
  if not ok or type(res) ~= "table" then return nil end
  return #res, res
end

-- Actors.
local actors = safeCount("getactors", getactors)

-- Nil-parented instances + top-classes breakdown.
local nilInstances, nilTopClasses
do
  if type(getnilinstances) ~= "function" then
    unavailable[#unavailable + 1] = "getnilinstances"
  else
    local ok, res = pcall(getnilinstances)
    if ok and type(res) == "table" then
      nilInstances = #res
      local counts = {}
      for _, inst in res do
        local cls = __class(inst)
        counts[cls] = (counts[cls] or 0) + 1
      end
      -- Reduce to a small sorted top-list.
      local arr = {}
      for cls, n in counts do arr[#arr + 1] = { class = cls, count = n } end
      table.sort(arr, function(a, b) return a.count > b.count end)
      nilTopClasses = {}
      for i = 1, math.min(#arr, 8) do nilTopClasses[i] = arr[i] end
    end
  end
end

-- Running scripts (also reused for the hidden-script scan).
local runningScripts, runningList
do
  local c, res = safeCount("getrunningscripts", getrunningscripts)
  runningScripts = c
  runningList = res
end

-- Loaded modules.
local loadedModules = safeCount("getloadedmodules", getloadedmodules)

-- Quick hidden-script count: any script not living "in tree".
local hiddenScripts = nil
do
  local available = (type(getrunningscripts) == "function") or (type(getscripts) == "function")
  if available then
    local count = 0
    local seen = {}
    local function consider(s)
      if s == nil or seen[s] then return end
      seen[s] = true
      if not __isA(s, "LuaSourceContainer") then return end
      local okLoc, loc = pcall(__location, s)
      if okLoc and loc ~= "in tree" then count = count + 1 end
    end
    if type(runningList) == "table" then
      for _, s in runningList do consider(s) end
    end
    if type(getscripts) == "function" then
      local okS, all = pcall(getscripts)
      if okS and type(all) == "table" then
        local n = 0
        for _, s in all do
          n = n + 1
          if n > 6000 then break end
          consider(s)
        end
      end
    end
    hiddenScripts = count
  else
    unavailable[#unavailable + 1] = "getscripts"
  end
end

return {
  actors = actors,
  nilInstances = nilInstances,
  nilTopClasses = nilTopClasses,
  runningScripts = runningScripts,
  loadedModules = loadedModules,
  hiddenScripts = hiddenScripts,
  unavailable = unavailable,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
