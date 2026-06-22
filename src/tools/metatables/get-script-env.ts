import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-script-env",
  title: "Dump a script's environment (getsenv)",
  description:
    "Resolve an instance path to a running LocalScript/ModuleScript and dump its script environment table via " +
    "getsenv. This is the live _ENV of that script: its globals, every top-level local it exposed as a global, and " +
    "the functions/values it defined. Use it to discover what a script holds (config flags, references, handler " +
    "functions) so you can then inspect or hook them by reference (e.g. feed getsenv(script).someFunc into " +
    "inspect-closure or hook-function). The script must be currently running for getsenv to succeed. Requires " +
    "getsenv. Returns { Script, KeyCount, Truncated, Keys } (keysOnly) or { Script, KeyCount, Truncated, Entries } " +
    "or { error }.",
  category: "Metatables & Closures",
  input: z.object({
    scriptPath: z
      .string()
      .describe(
        "Luau expression resolving to the LocalScript/ModuleScript instance, e.g. 'game.Players.LocalPlayer.PlayerScripts.Main' or 'game:GetService(\"ReplicatedStorage\").Modules.Net'. Evaluated as `return <scriptPath>`; must yield a running script instance.",
      ),
    keysOnly: z
      .boolean()
      .describe(
        "When true (default) return only the environment key names — cheap and safe. When false also serialize each value's type and a scalar/string preview via __encVal.",
      )
      .optional()
      .default(true),
    maxKeys: z
      .number()
      .int()
      .min(1)
      .describe(
        "Maximum number of environment keys/entries to return before truncating (default 200).",
      )
      .optional()
      .default(200),
    threadContext: z.number().int().optional(),
  }),
  async execute({ scriptPath, keysOnly, maxKeys, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(getsenv) ~= "function" then return { error = "getsenv is not available in this executor." } end
local script, err = __eval(${q(scriptPath)})
if err then return { error = err } end
if typeof(script) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(script) .. ")." } end

local okEnv, env = pcall(getsenv, script)
if not okEnv then return { error = "getsenv failed (is the script running?): " .. tostring(env) } end
if type(env) ~= "table" then return { error = "getsenv did not return an environment table (got " .. typeof(env) .. ")." } end

local cap = ${maxKeys}
local count = 0
local kept = 0
local keysOnly = ${keysOnly ? "true" : "false"}
local keys = {}
local entries = {}

pcall(function()
  for k, v in pairs(env) do
    count = count + 1
    if kept < cap then
      kept = kept + 1
      if keysOnly then
        keys[#keys + 1] = tostring(k)
      else
        entries[#entries + 1] = { Key = tostring(k), Type = typeof(v), Value = __encVal(v) }
      end
    end
  end
end)

local result = { Script = ${q(scriptPath)}, KeyCount = count, Truncated = count > cap }
if keysOnly then result.Keys = keys else result.Entries = entries end
return result
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
