import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, q, type ValueArg } from "../_shared/reflection.js";

/**
 * call-closure
 * ------------
 * Resolve a Luau expression to a function and INVOKE it with a list of typed
 * arguments, capturing every return value. This is the "just call it" companion
 * to the by-reference inspection tools (inspect-closure, get-closure-*):
 * once you've located an internal/hidden function — a remote handler from
 * getconnections, a metamethod from getrawmetatable, a value pulled out of
 * getsenv(script), or any closure dredged up from the GC — you can fire it
 * directly with controlled inputs and read back what it produces.
 *
 * The whole call is pcall-guarded so a bad target or a function that raises
 * never aborts the run; instead the raised error is reported in `error`.
 */

const valueArgSchema = z
  .object({
    kind: z
      .enum(["string", "number", "boolean", "nil", "raw"])
      .describe(
        "How to interpret `value`. 'string'/'number'/'boolean' pass that literal scalar. 'nil' passes a nil argument " +
          "(ignores `value`). 'raw' treats `value` as a Luau expression that is evaluated at call time — use it for any " +
          "non-primitive argument such as Vector3.new(1,2,3), Color3.fromRGB(255,0,0), Enum.KeyCode.E, CFrame.new(), a " +
          "table like {1,2,3}, or an Instance reference like game.Workspace.Part.",
      ),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .describe(
        "The literal value for kind='string'/'number'/'boolean'; OR, when kind='raw', a Luau expression string such as " +
          "'Vector3.new(0,50,0)', 'Enum.Material.Neon', 'game.Players.LocalPlayer', or '{ a = 1, b = 2 }'. Omit entirely " +
          "when kind='nil'.",
      )
      .optional(),
  })
  .describe("A single positional argument to pass to the function, expressed as a typed value.");

export default defineTool({
  name: "call-closure",
  title: "Call any function directly with arguments and capture its result",
  description:
    "ACTS ON LIVE GAME STATE — EXECUTES THE FUNCTION. Resolve a Luau expression to a function and CALL it with an " +
    "ordered list of typed arguments, returning every value it produces. This lets you invoke internal, hidden, or " +
    "anonymous functions on demand: a remote's OnClientEvent handler (getconnections(remote.OnClientEvent)[1]." +
    "Function), a metamethod (getrawmetatable(game).__namecall), a member pulled from a script env " +
    "(getsenv(script).someFunc), a constant/upvalue you extracted, or any closure found in the GC. Each argument is a " +
    "typed value; use kind='raw' for non-primitive arguments (Vector3, Color3, Enum, CFrame, tables, Instance " +
    "references, ...). The call is fully pcall-guarded, so a function that errors reports its message instead of " +
    "aborting. WARNING: this genuinely runs the target function with the arguments you supply — it MAY cause side " +
    "effects, mutate game state, fire remotes to the server, or trip anti-cheat. Only call functions you understand. " +
    "Returns { Target, ok, returns, returnCount, truncated, argCount } on success, or { Target, ok=false, error, " +
    "argCount } when the function raised.",
  category: "Instrumentation",
  mutatesState: true,
  input: z.object({
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to the function to call, e.g. " +
          "'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).update', " +
          "'getrawmetatable(game).__namecall', " +
          "'getconnections(game.Workspace.Part.Touched)[1].Function', or 'getgenv().myGlobalFn'. " +
          "Evaluated as `return <functionPath>`; the result must be a function.",
      ),
    args: z
      .array(valueArgSchema)
      .describe(
        "Ordered list of positional arguments to pass to the function. Omit or pass [] to call it with no arguments. " +
          "Each entry is a typed value; use kind='raw' for anything that isn't a plain string/number/boolean/nil.",
      )
      .optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ functionPath, args, threadContext }, ctx) {
    const argList: ValueArg[] = args ?? [];
    const argExprs = argList.map(buildValueExpr);
    const argCount = argExprs.length;
    const splicedArgs = argExprs.join(", ");

    const source = `
local function __encVal(v)
  local t = typeof(v)
  if t == "Instance" then
    local ok, n = pcall(function() return v:GetFullName() end)
    return ok and ("Instance: " .. n) or "<Instance>"
  end
  if t == "string" or t == "number" or t == "boolean" then return v end
  if t == "nil" then return "nil" end
  local ok, s = pcall(tostring, v)
  return ok and (t .. ": " .. tostring(s)) or ("<" .. t .. ">")
end

-- Resolve the target function.
local __chunk, __cerr = loadstring("return " .. ${q(functionPath)})
if not __chunk then
  return { Target = ${q(functionPath)}, ok = false, error = "compile error in functionPath: " .. tostring(__cerr), argCount = ${argCount} }
end
local __rok, __fn = pcall(__chunk)
if not __rok then
  return { Target = ${q(functionPath)}, ok = false, error = "error evaluating functionPath: " .. tostring(__fn), argCount = ${argCount} }
end
if type(__fn) ~= "function" then
  return { Target = ${q(functionPath)}, ok = false, error = "functionPath did not resolve to a function (got " .. typeof(__fn) .. ")", argCount = ${argCount} }
end

-- Call it, capturing all results (incl. the leading pcall ok flag) safely with nils preserved.
local res = table.pack(pcall(__fn${splicedArgs ? ", " + splicedArgs : ""}))
local ok = res[1]

if not ok then
  return { Target = ${q(functionPath)}, ok = false, error = tostring(res[2]), argCount = ${argCount} }
end

-- Encode return values 2..n, capping at 12.
local cap = 12
local returns = {}
local total = res.n - 1
if total < 0 then total = 0 end
local emit = math.min(total, cap)
for i = 1, emit do
  returns[i] = { Index = i, Type = typeof(res[i + 1]), Value = __encVal(res[i + 1]) }
end

return {
  Target = ${q(functionPath)},
  ok = true,
  returns = returns,
  returnCount = total,
  truncated = total > cap,
  argCount = ${argCount},
}
`;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
