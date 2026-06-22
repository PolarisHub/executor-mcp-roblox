import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "hook-function",
  title: "Hook a live function with a replacement (MUTATES STATE)",
  description:
    "WRITES LIVE GAME STATE. DANGER — MUTATES STATE PERSISTENTLY. Resolve a target function and replace it with your own function via " +
    "hookfunction. After hooking, every call to the target — from anywhere in the game — runs your replacement " +
    "instead. This is the core primitive for intercepting/altering game behavior: log or rewrite arguments, spoof " +
    "return values, or no-op a check. The hook is GLOBAL and PERSISTS until undone, so it can easily destabilize the " +
    "game or trip anticheat. The original function is captured and stored in getgenv().__mcp_hooks keyed by the " +
    "target expression so you can recover it; you (or your replacement) can call the original, and you can fully " +
    "undo the hook with restorefunction(target). Requires hookfunction. Pass confirm=true to proceed. Returns " +
    "{ Target, Hooked, OriginalStored } or { error }.",
  category: "Metatables & Closures",
  mutatesState: true,
  input: z.object({
    targetPath: z
      .string()
      .describe(
        "Luau expression resolving to the function to hook (the one whose calls you want to intercept), e.g. 'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).validate' or 'getrawmetatable(game).__namecall'. Evaluated as `return <targetPath>`.",
      ),
    hookFunction: z
      .string()
      .describe(
        "Raw Luau expression that evaluates to the REPLACEMENT function. Typically a function literal, e.g. 'function(...) print(\"called\", ...) return getgenv().__mcp_hooks[<target>](...) end' or 'newcclosure(function(...) return true end)'. To call the original from inside your hook, read it from getgenv().__mcp_hooks. Evaluated as `return <hookFunction>` and must resolve to a function.",
      ),
    confirm: z
      .boolean()
      .describe(
        "Must be true to actually install the hook (global, persistent mutation). When omitted or false, the tool refuses and changes nothing.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ targetPath, hookFunction, confirm, threadContext }, ctx) {
    if (confirm !== true) {
      return {
        data: {
          error:
            "Refusing to hook function (global persistent mutation of live state); pass confirm=true.",
        },
        isError: true,
      };
    }

    const source = `
${REFLECT_PRELUDE}
if type(hookfunction) ~= "function" then return { error = "hookfunction is not available in this executor." } end
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor; cannot store the original for restoration." } end

local target, terr = __evalFn(${q(targetPath)})
if terr then return { error = "target: " .. terr } end
local hookFn, herr = __evalFn(${q(hookFunction)})
if herr then return { error = "hookFunction: " .. herr } end

local genv = getgenv()
if type(genv.__mcp_hooks) ~= "table" then genv.__mcp_hooks = {} end

local key = ${q(targetPath)}
local stored = false
local ok, original = pcall(hookfunction, target, hookFn)
if not ok then return { error = "hookfunction failed: " .. tostring(original) } end
if type(original) == "function" then
  -- Only store the first original so re-hooking does not clobber the true original.
  if genv.__mcp_hooks[key] == nil then genv.__mcp_hooks[key] = original end
  -- Parallel metadata registry so list-hooks / restore-hook can find + undo it.
  if type(genv.__mcp_hook_meta) ~= "table" then genv.__mcp_hook_meta = {} end
  if genv.__mcp_hook_meta[key] == nil then
    genv.__mcp_hook_meta[key] = { kind = "function", targetExpr = ${q(targetPath)} }
  end
  stored = true
end

return { Target = key, Hooked = true, OriginalStored = stored }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
