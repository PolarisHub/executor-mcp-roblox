import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-closure-constants",
  title: "Read a closure's constant pool",
  description:
    "Resolve a Luau expression to a function and dump its constant pool via getconstants. Constants are the literal " +
    "values the bytecode references — strings, numbers, table keys, global names, and embedded function/method " +
    "names — so they are the fastest way to fingerprint what a closure does (e.g. spotting a 'FireServer' literal, a " +
    "remote name, a damage value, or a URL) without reading its source. This is the by-reference companion to the " +
    "GC-wide scanners (find-functions-by-constant / find-constants-xref): use it once you already hold the function " +
    "(a remote handler, a metamethod, getsenv(script).fn, etc.). Each entry reports its 1-based Index, Luau Type, " +
    "and an encoded Value. Requires the executor's getconstants (debug.getconstants); if unavailable a clean " +
    "{ error } is returned. Returns { Target, Info, Constants:[{Index,Type,Value}], Count } or { error }.",
  category: "Metatables & Closures",
  input: z.object({
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to a function whose constants you want, e.g. " +
          "'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).update', 'getrawmetatable(game).__namecall', or " +
          "'getconnections(game.ReplicatedStorage.Remote.OnClientEvent)[1].Function'. Evaluated as `return <functionPath>`.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ functionPath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(__getconstants) ~= "function" then return { error = "getconstants is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end

local ok, c = pcall(__getconstants, fn)
if not ok then return { error = "getconstants failed: " .. tostring(c) } end
if type(c) ~= "table" then return { error = "getconstants did not return a table (got " .. typeof(c) .. ")." } end

local list = {}
for i, v in ipairs(c) do
  list[i] = { Index = i, Type = typeof(v), Value = __encVal(v) }
end

return {
  Target = ${q(functionPath)},
  Info = __fnInfo(fn),
  Constants = list,
  Count = #list,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
