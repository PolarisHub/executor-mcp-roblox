import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-closure-protos",
  title: "List a closure's nested function prototypes",
  description:
    "Resolve a Luau expression to a function and enumerate its nested prototypes (protos) via getprotos. Protos are " +
    "the inner functions defined inside a closure — closures it creates, callbacks it registers, helper functions " +
    "in its body. Walking protos lets you drill into a top-level script function to reach the exact inner handler " +
    "you care about (e.g. an anonymous OnClientEvent callback) without scanning the whole GC, and to map a script's " +
    "internal call structure. For each proto this returns the full __fnInfo (IsLua/IsC, Name, Source, ShortSource, " +
    "LineDefined, NumParams, IsVararg, NumUpvalues, Pointer) so you can immediately feed a Pointer/path back into " +
    "the other closure tools. Requires the executor's getprotos (debug.getprotos); if unavailable a clean { error } " +
    "is returned. Returns { Target, Info, Protos:[__fnInfo...], Count } or { error }.",
  category: "Metatables & Closures",
  input: z.object({
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to a function whose nested prototypes you want, e.g. " +
          "'getscriptclosure(game.Players.LocalPlayer.PlayerScripts.Main)', " +
          "'getsenv(script).init', or 'getrawmetatable(game).__namecall'. Evaluated as `return <functionPath>`.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ functionPath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(__getprotos) ~= "function" then return { error = "getprotos is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end

local ok, p = pcall(__getprotos, fn)
if not ok then return { error = "getprotos failed: " .. tostring(p) } end
if type(p) ~= "table" then return { error = "getprotos did not return a table (got " .. typeof(p) .. ")." } end

local list = {}
for i, child in ipairs(p) do
  list[i] = (type(child) == "function") and __fnInfo(child) or { Index = i, Type = typeof(child), Value = __encVal(child) }
end

return {
  Target = ${q(functionPath)},
  Info = __fnInfo(fn),
  Protos = list,
  Count = #list,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
