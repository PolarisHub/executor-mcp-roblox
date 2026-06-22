import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-closure-upvalues",
  title: "Read a closure's upvalues (captured variables)",
  description:
    "Resolve a Luau expression to a function and dump its upvalues via getupvalues. Upvalues are the variables a " +
    "closure captured from its enclosing scope — the live state a function carries with it (config tables, cached " +
    "remotes, counters, references to other functions, flags). Inspecting them reveals hidden state that source code " +
    "alone does not show, which is invaluable when reverse-engineering a handler or locating a kill-switch/flag to " +
    "flip. This is the by-reference companion to find-upvalue-xref. Each entry reports its 1-based Index, Luau Type, " +
    "and an encoded Value; the same Index is what set-closure-upvalue mutates. Requires the executor's getupvalues " +
    "(debug.getupvalues); if unavailable a clean { error } is returned. Returns " +
    "{ Target, Info, Upvalues:[{Index,Type,Value}], Count } or { error }.",
  category: "Metatables & Closures",
  input: z.object({
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to a function whose upvalues you want, e.g. " +
          "'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).step', 'getrawmetatable(game).__index', or " +
          "'getconnections(workspace.Part.Touched)[1].Function'. Evaluated as `return <functionPath>`. Captured " +
          "variables are editable by Index via set-closure-upvalue.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ functionPath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(__getupvalues) ~= "function" then return { error = "getupvalues is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end

local ok, u = pcall(__getupvalues, fn)
if not ok then return { error = "getupvalues failed: " .. tostring(u) } end
if type(u) ~= "table" then return { error = "getupvalues did not return a table (got " .. typeof(u) .. ")." } end

local list = {}
for i, v in ipairs(u) do
  list[i] = { Index = i, Type = typeof(v), Value = __encVal(v) }
end

return {
  Target = ${q(functionPath)},
  Info = __fnInfo(fn),
  Upvalues = list,
  Count = #list,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
