import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-script-closure",
  title: "Get a script's main closure (LocalScript/ModuleScript)",
  description:
    "Resolve a Luau expression to a LocalScript or ModuleScript Instance and retrieve its compiled main function via " +
    "getscriptclosure (falling back to getscriptfunction if the executor exposes that name instead). The returned " +
    "closure is the script's top-level chunk WITHOUT running it — so you can statically analyse a script's bytecode " +
    "(its constants, upvalues, and nested protos) even when it is protected, never executed, or you don't want its " +
    "side effects. This is the entry point for static RE of a single script: feed the resulting function into " +
    "get-closure-constants / get-closure-upvalues / get-closure-protos to drill in. Requires the executor's " +
    "getscriptclosure (or getscriptfunction); if neither exists a clean { error } is returned. Returns " +
    "{ Script, Function:__fnInfo, ConstantCount, UpvalueCount } or { error }.",
  category: "Metatables & Closures",
  input: z.object({
    scriptPath: z
      .string()
      .describe(
        "Luau expression resolving to a LocalScript or ModuleScript Instance, e.g. " +
          "'game.Players.LocalPlayer.PlayerScripts.Main', " +
          "'game.ReplicatedStorage.Modules.Settings', or 'game:GetService(\"ReplicatedFirst\").Loader'. " +
          "Evaluated as `return <scriptPath>`; the value must be an Instance.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ scriptPath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
local __getScriptClosure = getscriptclosure or getscriptfunction
if type(__getScriptClosure) ~= "function" then
  return { error = "getscriptclosure (and getscriptfunction) are not available in this executor." }
end

local scr, err = __eval(${q(scriptPath)})
if err then return { error = err } end
if typeof(scr) ~= "Instance" then
  return { error = "scriptPath did not resolve to an Instance (got " .. typeof(scr) .. "). Provide a LocalScript or ModuleScript." }
end

local scriptName
local okName, n = pcall(function() return scr:GetFullName() end)
scriptName = okName and n or tostring(scr)

local ok, fn = pcall(__getScriptClosure, scr)
if not ok then return { error = "getscriptclosure failed: " .. tostring(fn) } end
if type(fn) ~= "function" then
  return { error = "getscriptclosure did not return a function (got " .. typeof(fn) .. ") for " .. scriptName .. "." }
end

local result = {
  Script = scriptName,
  ScriptClassName = scr.ClassName,
  Function = __fnInfo(fn),
}

if type(__getconstants) == "function" then
  local okC, c = pcall(__getconstants, fn)
  if okC and type(c) == "table" then result.ConstantCount = #c end
end

if type(__getupvalues) == "function" then
  local okU, u = pcall(__getupvalues, fn)
  if okU and type(u) == "table" then result.UpvalueCount = #u end
end

return result
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
