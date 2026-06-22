import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "count-function-calls",
  title: "Count how many times a function is called (MUTATES STATE via hookfunction)",
  description:
    "WRITES LIVE GAME STATE — INSTALLS A PERSISTENT GLOBAL HOOK. Lightweight call-frequency counter for any function: " +
    "hook a target so that every invocation bumps an integer counter, then read the counter, then restore the original. " +
    "Unlike hook-and-log-function (which records full args/returns), this captures ONLY a count, so it is the cheapest " +
    "way to answer 'is this function actually being called, and how often?' — ideal for confirming an anticheat tick " +
    "fires, measuring how hot a code path is, or verifying a remote handler runs.\n\n" +
    "WORKFLOW (stateful — survives across tool calls via getgenv().__mcp_callCounts, keyed by functionPath):\n" +
    "  1. action='start' with functionPath — resolves the target, captures the original, installs a counting hook that " +
    "transparently calls the original and increments a counter. Returns { started, key }.\n" +
    "  2. action='fetch' with the same functionPath — returns { calls } captured so far WITHOUT stopping. Poll to watch live.\n" +
    "  3. action='stop' with the same functionPath — restores the original and clears the entry. Returns { stopped, calls }.\n\n" +
    "CAVEATS: the hook is GLOBAL and PERSISTS until you stop it (or the client restarts), adds (small) overhead on every " +
    "call, and a live function hook CAN TRIP ANTICHEAT — always stop when done. The counting work is pcall-isolated and " +
    "the hook always calls through to the original, so behavior is unchanged. Requires hookfunction, newcclosure, and " +
    "getgenv; restoration uses hookfunction(target, original) with a restorefunction fallback. Returns { error } if a " +
    "capability is missing, the target cannot be resolved, or there is no active counter for fetch/stop.",
  category: "Instrumentation",
  mutatesState: true,
  input: z.object({
    action: z
      .enum(["start", "fetch", "stop"])
      .describe(
        "'start' installs the counting hook on functionPath; 'fetch' returns the call count so far (hook stays live); " +
          "'stop' restores the original function and clears the counter. Use the SAME functionPath for all three so they " +
          "address the same registry entry.",
      ),
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to the function to count, e.g. " +
          "'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).heartbeat', 'getrawmetatable(game).__namecall', or " +
          "'getconnections(game.Workspace.Part.Touched)[1].Function'. Evaluated as `return <functionPath>` and must " +
          "resolve to a function. REQUIRED for 'start'. For 'fetch'/'stop' it is the registry key identifying which " +
          "running counter to act on, so it must match the string used at start.",
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
            "functionPath is required to identify which running counter to " +
            action +
            " (use the same expression you passed to start).",
        },
        isError: true,
      };
    }

    const keyExpr = q(functionPath);

    const prelude = `
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor; cannot maintain the counter registry." } end
local __genv = getgenv()
if type(__genv.__mcp_callCounts) ~= "table" then __genv.__mcp_callCounts = {} end
local __KEY = ${keyExpr}

local function __resolveTarget()
  local okc, fn = pcall(loadstring, "return " .. __KEY)
  if not okc or type(fn) ~= "function" then return nil, "compile error resolving target expression" end
  local oke, val = pcall(fn)
  if not oke then return nil, "error evaluating target expression: " .. tostring(val) end
  if type(val) ~= "function" then return nil, "expression did not resolve to a function (got " .. tostring(typeof(val)) .. ")" end
  return val, nil
end
`;

    let body: string;

    if (action === "start") {
      body = `
if type(hookfunction) ~= "function" then return { error = "hookfunction is not available in this executor." } end
if type(newcclosure) ~= "function" then return { error = "newcclosure is not available in this executor." } end

local existing = __genv.__mcp_callCounts[__KEY]
if existing and existing.active then
  return { error = "A counter is already active for this functionPath. Fetch it or stop it before starting again.", key = __KEY }
end

local target, terr = __resolveTarget()
if not target then return { error = "target: " .. tostring(terr) } end

-- Refuse to stack on a function another instrument tool already hooked (stacking
-- strands hooks whose "original" is another tool's wrapper). Owner map is keyed
-- by the target object with weak keys so it never leaks.
if type(__genv.__mcp_hookOwners) ~= "table" then __genv.__mcp_hookOwners = setmetatable({}, { __mode = "k" }) end
local __OWNERTAG = "count:" .. __KEY
local __owner = __genv.__mcp_hookOwners[target]
if __owner and __owner ~= __OWNERTAG then
  return { error = "This function is already instrumented by another tool ('" .. tostring(__owner) .. "'). Stop that one first to avoid stacking hooks.", key = __KEY }
end

-- Register the entry BEFORE hooking so the hook closure can find it immediately.
-- Keep the resolved target object so stop restores the EXACT closure we hooked.
local entry = { calls = 0, orig = nil, target = target, active = true, startedAt = (type(os) == "table" and os.clock and os.clock()) or 0 }
__genv.__mcp_callCounts[__KEY] = entry

local hook = newcclosure(function(...)
  local e = __genv.__mcp_callCounts[__KEY]
  if e and e.active then
    pcall(function() e.calls = (e.calls or 0) + 1 end)
  end
  if e and type(e.orig) == "function" then
    return e.orig(...)
  end
  return ...
end)

local okh, orig = pcall(hookfunction, target, hook)
if not okh then
  __genv.__mcp_callCounts[__KEY] = nil
  return { error = "hookfunction failed: " .. tostring(orig) }
end
if type(orig) ~= "function" then
  __genv.__mcp_callCounts[__KEY] = nil
  return { error = "hookfunction did not return the original function; aborting to keep state clean." }
end
entry.orig = orig
__genv.__mcp_hookOwners[target] = __OWNERTAG

return { started = true, key = __KEY }
`;
    } else if (action === "fetch") {
      body = `
local entry = __genv.__mcp_callCounts[__KEY]
if type(entry) ~= "table" then
  return { error = "No active counter for this functionPath. Did you start it (with the same expression)?", key = __KEY }
end
return { key = __KEY, active = entry.active == true, calls = entry.calls or 0 }
`;
    } else {
      body = `
local entry = __genv.__mcp_callCounts[__KEY]
if type(entry) ~= "table" then
  return { error = "No active counter for this functionPath; nothing to stop.", key = __KEY }
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

local total = entry.calls or 0
entry.active = false
-- Only drop the entry once restoration is confirmed; otherwise keep it (and
-- entry.orig) so the still-installed hook keeps calling through to the original
-- and a later stop can retry instead of stranding the function.
if restored then
  __genv.__mcp_callCounts[__KEY] = nil
  if type(__genv.__mcp_hookOwners) == "table" and target then __genv.__mcp_hookOwners[target] = nil end
end

return {
  stopped = true,
  key = __KEY,
  calls = total,
  restored = restored,
  warning = restored and nil or ("Could not confirm restoration of the original function" .. (restoreErr and (": " .. restoreErr) or "") .. ". The hook may still be active."),
}
`;
    }

    const source = prelude + body;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
