import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "hook-metamethod",
  title: "Hook a metamethod on an object (MUTATES live state)",
  description:
    "WRITES LIVE GAME STATE. DANGER — MUTATES STATE PERSISTENTLY. Resolve a Luau expression to an object and replace one of its " +
    "metamethods (e.g. __namecall, __index, __newindex) with your own function via hookmetamethod. The hook stays " +
    "active and INTERCEPTS EVERY call routed through that metamethod (for __namecall that is essentially every " +
    "method call in the game), so a slow, throwing, or mis-behaving hook can hang or crash the client and is a strong " +
    "anticheat signal. The original metamethod is stored in getgenv().__mcp_hooks under a descriptive key so you can " +
    "later restore it with restorefunction or by re-hooking the saved original. Your hook function typically wraps the " +
    "stored original (call it for unhandled cases) and should be a C closure (wrap it in newcclosure) to look native. " +
    "Requires hookmetamethod. Because it mutates state you MUST pass confirm=true; otherwise the tool refuses and does " +
    "nothing. Returns { Target, Method, Hooked, OriginalStored } or { error }.",
  category: "Metatables & Closures",
  mutatesState: true,
  input: z.object({
    objectPath: z
      .string()
      .describe(
        "Luau expression resolving to the object whose metamethod you want to hook, e.g. 'game', " +
          "'game.Players.LocalPlayer', or 'getgenv().SomeTable'. Evaluated as `return <objectPath>`.",
      ),
    method: z
      .string()
      .describe(
        "The metamethod name to hook, e.g. '__namecall', '__index', '__newindex'. __namecall is the usual target " +
          "for intercepting method calls (RemoteEvent:FireServer, etc.).",
      ),
    hookFunction: z
      .string()
      .describe(
        "Raw Luau expression evaluating to the replacement function, MUST resolve to a function. Usually wrapped in " +
          "newcclosure so it appears as a native C closure, e.g. " +
          '\'newcclosure(function(self, ...) local m = getnamecallmethod(); if m == "FireServer" then return end; ' +
          'return getgenv().__mcp_hooks["..."](self, ...) end)\'. Evaluated as `return <hookFunction>`.',
      ),
    confirm: z
      .boolean()
      .describe(
        "Safety gate. Must be exactly true to apply the hook. If omitted or false the tool refuses and does nothing, " +
          "because a persistent metamethod hook intercepts every call through it and can crash the game or trip anticheat.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ objectPath, method, hookFunction, confirm, threadContext }, ctx) {
    if (confirm !== true) {
      return {
        data: { error: "Refusing to hook a live metamethod; pass confirm=true." },
        isError: true,
      };
    }

    const source = `
${REFLECT_PRELUDE}
if type(hookmetamethod) ~= "function" then return { error = "hookmetamethod is not available in this executor." } end
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor; cannot store the original for restoration." } end

local obj, objErr = __eval(${q(objectPath)})
if objErr then return { error = objErr } end

local hookFn, hookErr = __eval(${q(hookFunction)})
if hookErr then return { error = "hookFunction: " .. hookErr } end
if type(hookFn) ~= "function" then return { error = "hookFunction did not resolve to a function (got " .. typeof(hookFn) .. ")." } end

local genv = getgenv()
if type(genv.__mcp_hooks) ~= "table" then genv.__mcp_hooks = {} end
local method = ${q(method)}
local hookKey = "metamethod:" .. tostring(obj) .. ":" .. method

local okHook, original = pcall(hookmetamethod, obj, method, hookFn)
if not okHook then return { error = "hookmetamethod failed: " .. tostring(original) } end

local stored = false
if type(original) == "function" then
  genv.__mcp_hooks[hookKey] = original
  -- Parallel metadata registry so list-hooks / restore-hook can find + undo it.
  if type(genv.__mcp_hook_meta) ~= "table" then genv.__mcp_hook_meta = {} end
  genv.__mcp_hook_meta[hookKey] = { kind = "metamethod", targetExpr = ${q(objectPath)}, method = method }
  stored = true
end

return {
  Target = ${q(objectPath)},
  Method = method,
  Hooked = true,
  OriginalStored = stored,
  HookKey = hookKey,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
