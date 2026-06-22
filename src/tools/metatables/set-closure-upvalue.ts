import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, q, REFLECT_PRELUDE, valueArgSchema } from "../_shared/reflection.js";

export default defineTool({
  name: "set-closure-upvalue",
  title: "Set an upvalue of a live function (MUTATES STATE)",
  description:
    "WRITES LIVE GAME STATE. DANGER — Resolve a Luau expression to a function and overwrite one of its upvalues (a " +
    "variable captured by the closure) via setupvalue. Use this to patch a function's behavior in place without " +
    "rehooking it — e.g. flip a captured `enabled` boolean, swap a captured config table, or zero out a captured " +
    "cooldown. The change persists for every future call of that exact closure and is shared by all closures that " +
    "captured the same upvalue, so it can destabilize the game or trip anticheat. Index is 1-based and must be within " +
    "the function's upvalue count (inspect-closure reports UpvalueCount). Requires setupvalue. Pass confirm=true to " +
    "proceed. Returns { Target, Index, ok } or { error }.",
  category: "Metatables & Closures",
  mutatesState: true,
  input: z.object({
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to the function whose upvalue you want to change, e.g. 'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).update' or 'getrawmetatable(game).__namecall'. Evaluated as `return <functionPath>`.",
      ),
    index: z
      .number()
      .int()
      .min(1)
      .describe(
        "1-based index of the upvalue to overwrite. Must be within the function's upvalue count (see UpvalueCount from inspect-closure).",
      ),
    value: valueArgSchema.describe(
      "New value for the upvalue. kind 'string'|'number'|'boolean' uses value literally; kind 'nil' sets nil; kind 'raw' treats value as a Luau expression evaluated for its result (e.g. value='Vector3.new(0,0,0)' or 'game.Workspace').",
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
        data: { error: "Refusing to set closure upvalue (mutates live state); pass confirm=true." },
        isError: true,
      };
    }

    const valueExpr = buildValueExpr(value);
    const source = `
${REFLECT_PRELUDE}
local __setupvalue = setupvalue or (type(debug) == "table" and debug.setupvalue) or nil
if type(__setupvalue) ~= "function" then return { error = "setupvalue is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end

local ok, serr = pcall(__setupvalue, fn, ${index}, ${valueExpr})
if not ok then return { error = "setupvalue failed: " .. tostring(serr) } end

return { Target = ${q(functionPath)}, Index = ${index}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
