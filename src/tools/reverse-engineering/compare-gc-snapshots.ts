import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

// Hard cap on how many GC objects we walk per pass. Counting by type() is cheap,
// so this is set high enough to cover a busy game's whole GC (tables/threads often
// cluster after a large run of userdata, so a low cap would under-count them — a
// real-game capture had 22.7k userdata before ~1k tables / 1.5k threads). The
// expensive part (function-pointer stringification) has its own smaller cap below.
// The GC of a busy game can
// contain hundreds of thousands of objects; enumerating all of them (and worse,
// stringifying every function pointer) can stall the client. We stop at this
// many and flag the result as truncated.
const MAX_OBJECTS = 200000;
// Separate, smaller cap on how many function pointers we remember per snapshot
// so the stored table (and the diff) stays manageable.
const MAX_FN_POINTERS = 4000;

export default defineTool({
  name: "compare-gc-snapshots",
  title: "Capture / compare GC snapshots",
  description:
    "Take a census of the garbage collector (getgc) and diff it over time to find what was allocated or freed between two points - a leak-hunting / behaviour-attribution tool.\n\n" +
    "Workflow: call with action='capture' (a baseline), perform some action in-game (open a menu, fire a remote, etc.), then call with action='compare' (same snapshotName) to see what changed.\n\n" +
    "Snapshots are stored CLIENT-SIDE in getgenv().__mcp_gc_snapshots[name], so they live in the target game and are naturally isolated per game / per session.\n\n" +
    "capture returns: { action='capture', name, ts, counts={ function, table, thread, total }, fnSampled, truncated }.\n" +
    "compare returns: { action='compare', name, baselineTs, nowTs, countDeltas={ function, table, thread, total }, newFunctions=[..pointers..], newFunctionCount, freedApprox (functions no longer present), sampledOnly, truncated }.\n\n" +
    "Caps: at most " +
    MAX_OBJECTS +
    " GC objects are walked per pass and at most " +
    MAX_FN_POINTERS +
    " function pointers are remembered; results note when truncation occurred, so treat large freed/new counts near the cap as approximate.",
  category: "Reverse Engineering",
  input: z.object({
    action: z
      .enum(["capture", "compare"])
      .describe(
        "'capture' stores a baseline census of the GC under snapshotName. 'compare' diffs the current GC against the previously stored snapshot of that name and reports new/freed functions and per-type count deltas.",
      ),
    snapshotName: z
      .string()
      .describe(
        "Name/slot for the snapshot (default 'default'). Use distinct names to keep several independent baselines around at once.",
      )
      .optional()
      .default("default"),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, snapshotName, threadContext }, ctx) {
    const isCapture = action === "capture";

    // Shared Luau: build a census of the current GC. Returns a local table
    // `census = { counts = {...}, fnSet = { [ptr]=true }, fnSampled = bool,
    // truncated = bool }`. Guarded so a missing getgc returns { error }.
    const source = `
local result = {}

local function censusGc()
  local getgcFn = getgc
  if type(getgcFn) ~= "function" then
    return nil, "getgc is not available in this executor."
  end

  -- Prefer the deep walk getgc(true); fall back to getgc() if it errors.
  local ok, objs = pcall(getgcFn, true)
  if not ok or type(objs) ~= "table" then
    ok, objs = pcall(getgcFn)
  end
  if not ok or type(objs) ~= "table" then
    return nil, "getgc() failed: " .. tostring(objs)
  end

  local counts = { ["function"] = 0, table = 0, thread = 0, other = 0, total = 0 }
  local fnSet = {}
  local fnSampled = false
  local truncated = false
  local seen = 0

  for _, obj in ipairs(objs) do
    seen = seen + 1
    if seen > ${MAX_OBJECTS} then
      truncated = true
      break
    end
    local t = type(obj)
    counts.total = counts.total + 1
    if t == "function" then
      counts["function"] = counts["function"] + 1
      if counts["function"] <= ${MAX_FN_POINTERS} then
        local okPtr, ptr = pcall(tostring, obj)
        if okPtr then fnSet[ptr] = true end
      else
        fnSampled = true
      end
    elseif t == "table" then
      counts.table = counts.table + 1
    elseif t == "thread" then
      counts.thread = counts.thread + 1
    else
      counts.other = counts.other + 1
    end
  end

  return { counts = counts, fnSet = fnSet, fnSampled = fnSampled, truncated = truncated }, nil
end

local function getStore()
  if type(getgenv) ~= "function" then return nil end
  local env = getgenv()
  if type(env) ~= "table" then return nil end
  if type(env.__mcp_gc_snapshots) ~= "table" then
    env.__mcp_gc_snapshots = {}
  end
  return env.__mcp_gc_snapshots
end

local function run()
  local NAME = ${q(snapshotName)}
  local store = getStore()
  if not store then
    return { error = "getgenv() is unavailable; cannot persist GC snapshots client-side." }
  end

  local census, err = censusGc()
  if not census then
    return { error = err }
  end

  ${
    isCapture
      ? `
  -- CAPTURE: store the census under NAME and return a summary.
  store[NAME] = {
    ts = os.time(),
    counts = census.counts,
    fnSet = census.fnSet,
    fnSampled = census.fnSampled,
    truncated = census.truncated,
  }
  return {
    action = "capture",
    name = NAME,
    ts = store[NAME].ts,
    counts = census.counts,
    fnSampled = census.fnSampled,
    truncated = census.truncated,
  }`
      : `
  -- COMPARE: diff the current census against the stored baseline.
  local base = store[NAME]
  if type(base) ~= "table" then
    return { error = "No snapshot named '" .. NAME .. "' to compare against. Run action='capture' first." }
  end

  local baseCounts = base.counts or {}
  local nowCounts = census.counts
  local function delta(key) return (nowCounts[key] or 0) - (baseCounts[key] or 0) end

  local countDeltas = {
    ["function"] = delta("function"),
    table = delta("table"),
    thread = delta("thread"),
    other = delta("other"),
    total = delta("total"),
  }

  -- Function pointer diff (sampled / capped sets).
  local baseFns = base.fnSet or {}
  local nowFns = census.fnSet
  local newFunctions = {}
  local newFunctionCount = 0
  for ptr in pairs(nowFns) do
    if not baseFns[ptr] then
      newFunctionCount = newFunctionCount + 1
      if #newFunctions < ${MAX_FN_POINTERS} then
        table.insert(newFunctions, ptr)
      end
    end
  end

  local freedApprox = 0
  for ptr in pairs(baseFns) do
    if not nowFns[ptr] then
      freedApprox = freedApprox + 1
    end
  end

  return {
    action = "compare",
    name = NAME,
    baselineTs = base.ts,
    nowTs = os.time(),
    countDeltas = countDeltas,
    baselineCounts = baseCounts,
    currentCounts = nowCounts,
    newFunctions = newFunctions,
    newFunctionCount = newFunctionCount,
    freedApprox = freedApprox,
    sampledOnly = (base.fnSampled == true) or (census.fnSampled == true),
    truncated = (base.truncated == true) or (census.truncated == true),
  }`
  }
end

local ok, res = pcall(run)
if ok then
  result = res
else
  result = { error = "compare-gc-snapshots failed: " .. tostring(res) }
end
return result`;

    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
