import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "trace-call-durations",
  title: "Profile how long a function takes per call (MUTATES STATE via hookfunction)",
  description:
    "WRITES LIVE GAME STATE — INSTALLS A PERSISTENT GLOBAL HOOK. Per-function profiler: hook a target so that every " +
    "invocation is timed with os.clock(), accumulating call count plus total/min/max time, then read the aggregated " +
    "stats, then restore the original. This is the fastest way to answer 'how expensive is this function and how often " +
    "does it run?' — ideal for finding the hot path in an anticheat loop, a render step, or a remote handler. Unlike " +
    "count-function-calls (count only) it also measures duration; unlike hook-and-log-function it stores only aggregates " +
    "(no per-call args), so it is cheap enough for hot paths.\n\n" +
    "WORKFLOW (stateful — survives across tool calls via getgenv().__mcp_callTimings, keyed by functionPath):\n" +
    "  1. action='start' with functionPath — resolves the target, captures the original, installs a timing wrapper that " +
    "transparently calls the original and records elapsed time. Returns { started, key }.\n" +
    "  2. action='fetch' with the same functionPath — returns { count, totalMs, avgMs, minMs, maxMs } so far WITHOUT " +
    "stopping. Poll to watch live.\n" +
    "  3. action='stop' with the same functionPath — restores the original and clears the entry. Returns final stats.\n\n" +
    "CAVEATS: the hook is GLOBAL and PERSISTS until you stop it (or the client restarts), adds (small) timing overhead on " +
    "every call, and a live function hook CAN TRIP ANTICHEAT — always stop when done. The original is called through " +
    "real-time (its return values are passed back unchanged); timing/aggregation is pcall-isolated. Requires " +
    "hookfunction, newcclosure, and getgenv; restoration uses hookfunction(target, original) with a restorefunction " +
    "fallback. Returns { error } if a capability is missing, the target cannot be resolved, or there is no active " +
    "profile for fetch/stop.",
  category: "Instrumentation",
  mutatesState: true,
  input: z.object({
    action: z
      .enum(["start", "fetch", "stop"])
      .describe(
        "'start' installs the timing wrapper on functionPath; 'fetch' returns the aggregated timing stats so far (hook " +
          "stays live); 'stop' restores the original function and clears the stats. Use the SAME functionPath for all " +
          "three so they address the same registry entry.",
      ),
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to the function to profile, e.g. " +
          "'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).update' or " +
          "'getrawmetatable(game).__namecall'. Evaluated as `return <functionPath>` and must resolve to a function. " +
          "REQUIRED for 'start'. For 'fetch'/'stop' it is the registry key identifying which running profile to act on, " +
          "so it must match the string used at start.",
      )
      .optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, functionPath, threadContext }, ctx) {
    if (action === "start" && !functionPath) {
      return {
        data: {
          error:
            "functionPath is required for action='start' (the Luau expression resolving to the target function).",
        },
        isError: true,
      };
    }
    if (!functionPath) {
      return {
        data: {
          error:
            "functionPath is required to identify which profile to " +
            action +
            " (use the same expression you passed to start).",
        },
        isError: true,
      };
    }

    const keyExpr = q(functionPath);

    const prelude = `
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor; cannot maintain the timing registry." } end
local __genv = getgenv()
if type(__genv.__mcp_callTimings) ~= "table" then __genv.__mcp_callTimings = {} end
local __KEY = ${keyExpr}

local function __resolveTarget()
  local okc, fn = pcall(loadstring, "return " .. __KEY)
  if not okc or type(fn) ~= "function" then return nil, "compile error resolving target expression" end
  local oke, val = pcall(fn)
  if not oke then return nil, "error evaluating target expression: " .. tostring(val) end
  if type(val) ~= "function" then return nil, "expression did not resolve to a function (got " .. tostring(typeof(val)) .. ")" end
  return val, nil
end

-- Build a {count,totalMs,avgMs,minMs,maxMs} report from an entry, guarding the no-call case.
local function __report(e)
  local count = e.count or 0
  local totalSec = e.total or 0
  local totalMs = totalSec * 1000
  return {
    count = count,
    totalMs = totalMs,
    avgMs = (count > 0) and (totalMs / count) or 0,
    minMs = (count > 0 and e.min ~= nil) and (e.min * 1000) or 0,
    maxMs = (count > 0 and e.max ~= nil) and (e.max * 1000) or 0,
  }
end
`;

    let body: string;

    if (action === "start") {
      body = `
if type(hookfunction) ~= "function" then return { error = "hookfunction is not available in this executor." } end
if type(newcclosure) ~= "function" then return { error = "newcclosure is not available in this executor." } end
if type(os) ~= "table" or type(os.clock) ~= "function" then return { error = "os.clock is not available; cannot time calls." } end

local existing = __genv.__mcp_callTimings[__KEY]
if existing and existing.active then
  return { error = "A profile is already active for this functionPath. Fetch it or stop it before starting again.", key = __KEY }
end

local target, terr = __resolveTarget()
if not target then return { error = "target: " .. tostring(terr) } end

-- Refuse to stack on a function another instrument tool already hooked. Owner map
-- is keyed by the target object with weak keys so it never leaks.
if type(__genv.__mcp_hookOwners) ~= "table" then __genv.__mcp_hookOwners = setmetatable({}, { __mode = "k" }) end
local __OWNERTAG = "trace:" .. __KEY
local __owner = __genv.__mcp_hookOwners[target]
if __owner and __owner ~= __OWNERTAG then
  return { error = "This function is already instrumented by another tool ('" .. tostring(__owner) .. "'). Stop that one first to avoid stacking hooks.", key = __KEY }
end

-- Keep the resolved target object so stop restores the EXACT closure we hooked.
local entry = { count = 0, total = 0, min = nil, max = nil, orig = nil, target = target, active = true, startedAt = os.clock() }
__genv.__mcp_callTimings[__KEY] = entry

local hook = newcclosure(function(...)
  local e = __genv.__mcp_callTimings[__KEY]
  local orig = e and e.orig
  if type(orig) ~= "function" then return ... end
  local t0 = os.clock()
  local results = table.pack(orig(...))
  local dt = os.clock() - t0
  if e and e.active then
    pcall(function()
      e.count = (e.count or 0) + 1
      e.total = (e.total or 0) + dt
      if e.min == nil or dt < e.min then e.min = dt end
      if e.max == nil or dt > e.max then e.max = dt end
    end)
  end
  return table.unpack(results, 1, results.n or #results)
end)

local okh, orig = pcall(hookfunction, target, hook)
if not okh then
  __genv.__mcp_callTimings[__KEY] = nil
  return { error = "hookfunction failed: " .. tostring(orig) }
end
if type(orig) ~= "function" then
  __genv.__mcp_callTimings[__KEY] = nil
  return { error = "hookfunction did not return the original function; aborting to keep state clean." }
end
entry.orig = orig
__genv.__mcp_hookOwners[target] = __OWNERTAG

return { started = true, key = __KEY }
`;
    } else if (action === "fetch") {
      body = `
local entry = __genv.__mcp_callTimings[__KEY]
if type(entry) ~= "table" then
  return { error = "No active profile for this functionPath. Did you start it (with the same expression)?", key = __KEY }
end
local r = __report(entry)
r.key = __KEY
r.active = entry.active == true
return r
`;
    } else {
      body = `
local entry = __genv.__mcp_callTimings[__KEY]
if type(entry) ~= "table" then
  return { error = "No active profile for this functionPath; nothing to stop.", key = __KEY }
end

local restored = false
local restoreErr = nil
-- Restore against the EXACT object that was hooked, not a re-resolution of the
-- expression (which may now yield a different closure and clobber it).
local target = entry.target
local terr = nil
if type(target) ~= "function" then target, terr = __resolveTarget() end

if type(entry.orig) == "function" and target and type(hookfunction) == "function" then
  local okr = pcall(hookfunction, target, entry.orig)
  if okr then restored = true else restoreErr = "hookfunction restore failed" end
end

if not restored and type(restorefunction) == "function" and target then
  local okrf = pcall(restorefunction, target)
  if okrf then restored = true else restoreErr = (restoreErr or "") .. " restorefunction failed" end
end

if not restored and terr then restoreErr = (restoreErr and (restoreErr .. "; ") or "") .. terr end

local r = __report(entry)
entry.active = false
-- Only drop the entry once restoration is confirmed; otherwise keep it (and
-- entry.orig) so the still-installed wrapper keeps calling through to the
-- original and a later stop can retry.
if restored then
  __genv.__mcp_callTimings[__KEY] = nil
  if type(__genv.__mcp_hookOwners) == "table" and target then __genv.__mcp_hookOwners[target] = nil end
end

r.stopped = true
r.key = __KEY
r.restored = restored
if not restored then
  r.warning = "Could not confirm restoration of the original function" .. (restoreErr and (": " .. restoreErr) or "") .. ". The hook may still be active."
end
return r
`;
    }

    const source = prelude + body;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
