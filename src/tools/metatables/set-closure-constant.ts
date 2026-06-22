import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, q, REFLECT_PRELUDE, valueArgSchema } from "../_shared/reflection.js";

export default defineTool({
  name: "set-closure-constant",
  title: "Set a constant of a live function (MUTATES STATE)",
  description:
    "WRITES LIVE GAME STATE. DANGER — Resolve a Luau expression to a function and overwrite one of its bytecode constants " +
    "via setconstant. Constants are the literal values baked into a function's bytecode (numbers, strings, the names " +
    "of globals/methods it calls). Patching one changes the function's behavior the next time it runs — e.g. rewrite " +
    "a magic number, swap a hardcoded string, or redirect a method call by changing its name constant. This persists " +
    "for the exact closure and can destabilize the game or trip anticheat; some executors only allow same-type " +
    "replacement. Index is 1-based and must be within the function's constant count (inspect-closure reports " +
    "ConstantCount). Requires setconstant. Pass confirm=true to proceed. Returns { Target, Index, ok } or { error }.",
  category: "Metatables & Closures",
  mutatesState: true,
  input: z.object({
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to the function whose constant you want to change, e.g. 'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).fire' or a function found via scan-closures-by-source. Evaluated as `return <functionPath>`.",
      ),
    index: z
      .number()
      .int()
      .min(1)
      .describe(
        "1-based index of the constant to overwrite. Must be within the function's constant count (see ConstantCount from inspect-closure).",
      ),
    value: valueArgSchema.describe(
      "New value for the constant. kind 'string'|'number'|'boolean' uses value literally; kind 'nil' sets nil; kind 'raw' treats value as a Luau expression evaluated for its result. Note: many executors require the replacement to be the same type as the original constant.",
    ),
    confirm: z
      .boolean()
      .describe(
        "Must be true to actually mutate the live function. When omitted or false, the tool refuses and changes nothing.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ functionPath, index, value, confirm, threadContext }, ctx) {
    if (confirm !== true) {
      return {
        data: {
          error: "Refusing to set closure constant (mutates live state); pass confirm=true.",
        },
        isError: true,
      };
    }

    const valueExpr = buildValueExpr(value);
    const source = `
${REFLECT_PRELUDE}
local __setconstant = setconstant or (type(debug) == "table" and debug.setconstant) or nil
if type(__setconstant) ~= "function" then return { error = "setconstant is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end

local ok, serr = pcall(__setconstant, fn, ${index}, ${valueExpr})
if not ok then return { error = "setconstant failed: " .. tostring(serr) } end

return { Target = ${q(functionPath)}, Index = ${index}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
