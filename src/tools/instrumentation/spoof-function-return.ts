import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, q } from "../_shared/reflection.js";

const valueArgSchema = z
  .object({
    kind: z
      .enum(["string", "number", "boolean", "nil", "raw"])
      .describe(
        "How to interpret `value`. 'string'/'number'/'boolean' force that literal scalar to be returned. 'nil' makes the " +
          "function return nil. 'raw' treats `value` as a Luau expression — REQUIRED for any non-primitive return type " +
          "(Vector3, CFrame, Color3, a table, an Instance reference, etc.).",
      ),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .describe(
        "The literal value (for string/number/boolean) or, when kind='raw', a Luau expression string such as " +
          "'true', '100', '{ valid = true }', 'Vector3.new(0,50,0)', or 'game.Workspace'. Omit entirely when kind='nil'.",
      )
      .optional(),
  })
  .describe("The value the spoofed function should always return, expressed as a typed argument.");

export default defineTool({
  name: "spoof-function-return",
  title: "Force a function to always return a chosen value (MUTATES STATE via hookfunction)",
  description:
    "WRITES LIVE GAME STATE — INSTALLS A PERSISTENT GLOBAL HOOK. Replaces a target function with a stub that IGNORES its " +
    "arguments and ALWAYS returns a value you choose, without ever calling the original. This is the canonical anticheat/" +
    "validation bypass: make a check like `isValid()` return true, force a server-config getter to return your value, or " +
    "stub a paywall test to return false. Distinct from block-function (which makes the target a no-op returning nothing) " +
    "because here you control the exact return value.\n\n" +
    "WORKFLOW (stateful — survives across tool calls via getgenv().__mcp_spoofReturns, keyed by functionPath):\n" +
    "  1. action='start' with functionPath + returnValue — resolves the target, captures the original, installs a stub " +
    "that returns your value. Returns { started, key, returns }.\n" +
    "  2. action='stop' with the same functionPath — restores the original function. Returns { stopped }.\n\n" +
    "CAVEATS: the hook is GLOBAL and PERSISTS until you stop it (or the client restarts). The original is NEVER called " +
    "while spoofed, so any side effects the real function had will not happen — this can desync state or destabilize the " +
    "game, and a live function hook CAN TRIP ANTICHEAT. Always stop when done. Requires hookfunction, newcclosure, and " +
    "getgenv; restoration uses hookfunction(target, original) with a restorefunction fallback. Returns { error } if a " +
    "capability is missing, the target cannot be resolved, or there is already an active spoof for fetch/stop.",
  category: "Instrumentation",
  mutatesState: true,
  input: z.object({
    action: z
      .enum(["start", "stop"])
      .describe(
        "'start' installs the return-spoofing stub on functionPath (requires returnValue); 'stop' restores the original " +
          "function. Use the SAME functionPath for both so they address the same registry entry.",
      ),
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to the function to spoof, e.g. " +
          "'getsenv(game.Players.LocalPlayer.PlayerScripts.AntiCheat).isValid' or " +
          "'getrawmetatable(game).__index'. Evaluated as `return <functionPath>` and must resolve to a function. " +
          "REQUIRED for 'start'. For 'stop' it is the registry key identifying which spoof to restore, so it must match " +
          "the string used at start.",
      )
      .optional(),
    returnValue: valueArgSchema.optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, functionPath, returnValue, threadContext }, ctx) {
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
            "functionPath is required to identify which spoof to " +
            action +
            " (use the same expression you passed to start).",
        },
        isError: true,
      };
    }
    if (action === "start" && !returnValue) {
      return {
        data: {
          error:
            "returnValue is required for action='start' (the typed value the function should always return).",
        },
        isError: true,
      };
    }

    const keyExpr = q(functionPath);
    const returnExpr = action === "start" ? buildValueExpr(returnValue!) : "nil";

    const prelude = `
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor; cannot maintain the spoof registry." } end
local __genv = getgenv()
if type(__genv.__mcp_spoofReturns) ~= "table" then __genv.__mcp_spoofReturns = {} end
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

local existing = __genv.__mcp_spoofReturns[__KEY]
if existing and existing.active then
  return { error = "A spoof is already active for this functionPath. Stop it before starting again.", key = __KEY }
end

-- Evaluate the chosen return value ONCE up front so a bad expression fails the start cleanly.
local okv, spoofVal = pcall(function() return ${returnExpr} end)
if not okv then return { error = "failed to evaluate returnValue: " .. tostring(spoofVal) } end

local target, terr = __resolveTarget()
if not target then return { error = "target: " .. tostring(terr) } end

-- Refuse to stack on a function another instrument tool already hooked. Owner map
-- is keyed by the target object with weak keys so it never leaks.
if type(__genv.__mcp_hookOwners) ~= "table" then __genv.__mcp_hookOwners = setmetatable({}, { __mode = "k" }) end
local __OWNERTAG = "spoof:" .. __KEY
local __owner = __genv.__mcp_hookOwners[target]
if __owner and __owner ~= __OWNERTAG then
  return { error = "This function is already instrumented by another tool ('" .. tostring(__owner) .. "'). Stop that one first to avoid stacking hooks.", key = __KEY }
end

-- Keep the resolved target object so stop restores the EXACT closure we hooked.
local entry = { orig = nil, target = target, active = true, value = spoofVal, startedAt = (type(os) == "table" and os.clock and os.clock()) or 0 }
__genv.__mcp_spoofReturns[__KEY] = entry

local hook = newcclosure(function(...)
  local e = __genv.__mcp_spoofReturns[__KEY]
  if e and e.active then
    return e.value
  end
  -- Spoof was cleared but hook still installed: fall back to the original.
  if e and type(e.orig) == "function" then return e.orig(...) end
  return ...
end)

local okh, orig = pcall(hookfunction, target, hook)
if not okh then
  __genv.__mcp_spoofReturns[__KEY] = nil
  return { error = "hookfunction failed: " .. tostring(orig) }
end
if type(orig) ~= "function" then
  __genv.__mcp_spoofReturns[__KEY] = nil
  return { error = "hookfunction did not return the original function; aborting to keep state clean." }
end
entry.orig = orig
__genv.__mcp_hookOwners[target] = __OWNERTAG

local enc = nil
pcall(function()
  local t = typeof(spoofVal)
  if t == "Instance" then local ok,n = pcall(function() return spoofVal:GetFullName() end); enc = ok and ("Instance: " .. n) or "<Instance>"
  else enc = tostring(spoofVal) end
end)

return { started = true, key = __KEY, returns = enc }
`;
    } else {
      body = `
local entry = __genv.__mcp_spoofReturns[__KEY]
if type(entry) ~= "table" then
  return { error = "No active spoof for this functionPath; nothing to stop.", key = __KEY }
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

entry.active = false
-- Only drop the entry once restoration is confirmed; otherwise keep it (and
-- entry.orig) so the still-installed stub falls back to e.orig(...) and a later
-- stop can retry instead of leaving the function spoofed forever.
if restored then
  __genv.__mcp_spoofReturns[__KEY] = nil
  if type(__genv.__mcp_hookOwners) == "table" and target then __genv.__mcp_hookOwners[target] = nil end
end

return {
  stopped = true,
  key = __KEY,
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
