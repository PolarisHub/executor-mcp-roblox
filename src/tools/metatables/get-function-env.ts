import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-function-env",
  title: "Dump a function's environment (getfenv)",
  description:
    "Resolve a Luau expression to a function and dump its function environment table via getfenv. This is the _ENV " +
    "the function reads its globals from: the global table the closure sees (often the script's environment, or a " +
    "sandboxed proxy). Use it to learn what globals a handler can reach, to spot a sandbox/proxy environment, or to " +
    "discover sibling functions you can then inspect or hook by reference. Read-only. Requires getfenv. Returns " +
    "{ Target, KeyCount, Truncated, Keys } (keysOnly) or { Target, KeyCount, Truncated, Entries } or { error }.",
  category: "Metatables & Closures",
  input: z.object({
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to a function, e.g. 'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).update', 'getrawmetatable(game).__namecall', or a function found via the gc-scan tools. Evaluated as `return <functionPath>`.",
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
  async execute({ functionPath, keysOnly, maxKeys, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(getfenv) ~= "function" then return { error = "getfenv is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end

local okEnv, env = pcall(getfenv, fn)
if not okEnv then return { error = "getfenv failed: " .. tostring(env) } end
if type(env) ~= "table" then return { error = "getfenv did not return an environment table (got " .. typeof(env) .. ")." } end

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

local result = { Target = ${q(functionPath)}, KeyCount = count, Truncated = count > cap }
if keysOnly then result.Keys = keys else result.Entries = entries end
return result
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
