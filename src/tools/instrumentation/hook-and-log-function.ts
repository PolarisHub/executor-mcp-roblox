import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "hook-and-log-function",
  title: "Hook a function and log every call (turnkey instrumentation, MUTATES STATE)",
  description:
    "DANGER — INSTALLS A PERSISTENT GLOBAL HOOK. Turnkey call-tracing for any function: hook a target, automatically " +
    "record every invocation (stringified arguments + return values + a timestamp), then fetch the captured call log " +
    "and restore the original — all from three actions of this one tool. This is the fastest way to answer 'what is " +
    "this function actually called with, how often, and what does it return?' without hand-writing a hook.\n\n" +
    "WORKFLOW (stateful — survives across tool calls via getgenv().__mcp_fnlogs, keyed by functionPath):\n" +
    "  1. action='start' with functionPath — resolves the target, captures the original, installs a logging hook that " +
    "transparently calls the original and records up to maxCalls invocations. Returns { started, key }.\n" +
    "  2. action='fetch' with the same functionPath — reads the accumulated call log so far WITHOUT stopping it. " +
    "Returns { count, max, calls } where each call is { args[], returns[], t }. Call repeatedly to watch live.\n" +
    "  3. action='stop' with the same functionPath — restores the original function and removes the registry entry. " +
    "Returns { stopped }. ALWAYS stop when done.\n\n" +
    "CAVEATS: The hook is GLOBAL and PERSISTS until you stop it (or the client restarts). It adds overhead on every " +
    "call to the target and CAN TRIP ANTICHEAT or destabilize the game, especially on hot paths — prefer specific, " +
    "low-frequency targets and keep maxCalls modest. Arguments/returns are captured by tostring (Instances become " +
    "GetFullName()) and both arrays are capped at 8 entries each. Logging stops accumulating once maxCalls is reached, " +
    "but the hook stays installed (and keeps calling the original) until you stop it. Requires hookfunction, " +
    "newcclosure, and getgenv; restoration uses hookfunction(target, original) with a restorefunction fallback. " +
    "Returns { error } with a clear message if a capability is missing, the target cannot be resolved, or there is " +
    "no active log for fetch/stop.",
  category: "Instrumentation",
  mutatesState: true,
  input: z.object({
    action: z
      .enum(["start", "fetch", "stop"])
      .describe(
        "What to do: 'start' installs the logging hook on functionPath; 'fetch' returns the call log captured so far " +
          "(hook stays live); 'stop' restores the original function and clears the log. Use the SAME functionPath for " +
          "all three so they address the same registry entry.",
      ),
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to the function to instrument, e.g. " +
          "'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).validate', 'getrawmetatable(game).__namecall', or " +
          "'getconnections(game.Workspace.Part.Touched)[1].Function'. Evaluated as `return <functionPath>` and must " +
          "resolve to a function. REQUIRED for 'start'. For 'fetch'/'stop' it is the registry key identifying which " +
          "running log to act on, so it must match the string used at start (defaults to the start expression).",
      )
      .optional(),
    maxCalls: z
      .number()
      .int()
      .describe(
        "Maximum number of calls to record before logging stops accumulating (default 100). On 'start' this sizes the " +
          "ring of captured calls; on 'fetch' it caps how many entries are returned in this response. Keep modest on " +
          "hot paths to limit overhead and output size.",
      )
      .optional()
      .default(100),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, functionPath, maxCalls, threadContext }, ctx) {
    const cap = Math.min(Math.max(Math.floor(maxCalls ?? 100), 1), 5000);

    if ((action === "start" || functionPath === undefined) && !functionPath) {
      return {
        data: {
          error:
            action === "start"
              ? "functionPath is required for action='start' (the Luau expression resolving to the target function)."
              : "functionPath is required to identify which running log to " +
                action +
                " (use the same expression you passed to start).",
        },
        isError: true,
      };
    }

    const keyExpr = q(functionPath);

    // Shared prelude: capability guards + safe value encoder + registry accessor.
    const prelude = `
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor; cannot maintain the call-log registry." } end
local __genv = getgenv()
if type(__genv.__mcp_fnlogs) ~= "table" then __genv.__mcp_fnlogs = {} end
local __KEY = ${keyExpr}

local function __enc(v)
  local ok, t = pcall(typeof, v)
  if not ok then t = type(v) end
  if t == "Instance" then
    local okn, n = pcall(function() return v:GetFullName() end)
    return okn and ("Instance: " .. tostring(n)) or "<Instance>"
  end
  local oks, s = pcall(tostring, v)
  if not oks then return "<" .. tostring(t) .. ">" end
  if t == "string" or t == "number" or t == "boolean" or t == "nil" then return s end
  return tostring(t) .. ": " .. s
end

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

local existing = __genv.__mcp_fnlogs[__KEY]
if existing and existing.active then
  return { error = "A log is already active for this functionPath. Fetch it or stop it before starting again.", key = __KEY }
end

local target, terr = __resolveTarget()
if not target then return { error = "target: " .. tostring(terr) } end

-- Create + register the entry BEFORE hooking so the hook closure can find it immediately.
local entry = { log = {}, max = ${cap}, orig = nil, active = true, startedAt = (type(os) == "table" and os.clock and os.clock()) or 0 }
__genv.__mcp_fnlogs[__KEY] = entry

local hook = newcclosure(function(...)
  local e = __genv.__mcp_fnlogs[__KEY]
  -- Always call the original first so behavior is unchanged even if logging errors.
  local packed = table.pack(...)
  local results
  if e and type(e.orig) == "function" then
    results = table.pack(e.orig(...))
  else
    results = table.pack(...)
  end
  if e and e.active and #e.log < e.max then
    pcall(function()
      local a = {}
      for i = 1, math.min(packed.n or #packed, 8) do
        local ok, v = pcall(__enc, packed[i])
        a[i] = ok and v or "?"
      end
      local r = {}
      for i = 1, math.min(results.n or #results, 8) do
        local ok, v = pcall(__enc, results[i])
        r[i] = ok and v or "?"
      end
      table.insert(e.log, {
        args = a,
        argc = packed.n or #packed,
        returns = r,
        retc = results.n or #results,
        t = (type(os) == "table" and os.clock and os.clock()) or 0,
      })
    end)
  end
  return table.unpack(results, 1, results.n or #results)
end)

local okh, orig = pcall(hookfunction, target, hook)
if not okh then
  -- Roll back the registry entry so a failed start does not leave a dangling log.
  __genv.__mcp_fnlogs[__KEY] = nil
  return { error = "hookfunction failed: " .. tostring(orig) }
end
if type(orig) ~= "function" then
  __genv.__mcp_fnlogs[__KEY] = nil
  return { error = "hookfunction did not return the original function; aborting to keep state clean." }
end
entry.orig = orig

return { started = true, key = __KEY, max = entry.max }
`;
    } else if (action === "fetch") {
      body = `
local entry = __genv.__mcp_fnlogs[__KEY]
if type(entry) ~= "table" then
  return { error = "No active log for this functionPath. Did you start it (with the same expression)?", key = __KEY }
end

local log = entry.log or {}
local limit = math.min(#log, ${cap})
local out = {}
for i = 1, limit do out[i] = log[i] end

return {
  key = __KEY,
  active = entry.active == true,
  count = #log,
  max = entry.max,
  reachedMax = (#log >= (entry.max or 0)),
  returnedCount = limit,
  truncated = limit < #log,
  calls = out,
}
`;
    } else {
      // stop
      body = `
local entry = __genv.__mcp_fnlogs[__KEY]
if type(entry) ~= "table" then
  return { error = "No active log for this functionPath; nothing to stop.", key = __KEY }
end

local restored = false
local restoreErr = nil
local target, terr = __resolveTarget()

if type(entry.orig) == "function" and target and type(hookfunction) == "function" then
  -- Re-hook the (current) target back to the captured original.
  local okr = pcall(hookfunction, target, entry.orig)
  if okr then restored = true else restoreErr = "hookfunction restore failed" end
end

if not restored and type(restorefunction) == "function" and target then
  local okrf = pcall(restorefunction, target)
  if okrf then restored = true else restoreErr = (restoreErr or "") .. " restorefunction failed" end
end

if not restored and terr then restoreErr = (restoreErr and (restoreErr .. "; ") or "") .. terr end

local captured = entry.log and #entry.log or 0
entry.active = false
__genv.__mcp_fnlogs[__KEY] = nil

return {
  stopped = true,
  key = __KEY,
  restored = restored,
  capturedCalls = captured,
  warning = restored and nil or ("Could not confirm restoration of the original function" .. (restoreErr and (": " .. restoreErr) or "") .. ". The hook may still be active."),
}
`;
    }

    const source = prelude + body;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
