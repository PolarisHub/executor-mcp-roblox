import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "inspect-closure",
  title: "Inspect a function/closure by reference",
  description:
    "Resolve a Luau expression to a function and dump everything about it in one call: whether it's a Lua or C " +
    "closure, its name/source/line/param count/upvalue count (via getinfo), its constants, its upvalues (captured " +
    "values), its nested-proto count, and its function hash. This is the by-reference counterpart to the gc-scan " +
    "tools (scan-closures-by-*) — use it when you already have a handle on the function (e.g. a remote's " +
    "OnClientEvent handler, a metamethod, or `getsenv(script).someFunc`). Requires getinfo/getconstants/getupvalues " +
    "as available; missing capabilities are simply omitted. Returns { Target, Info, Constants, Upvalues, ProtoCount, FunctionHash } or { error }.",
  category: "Metatables & Closures",
  input: z.object({
    functionPath: z
      .string()
      .describe(
        "Luau expression resolving to a function, e.g. 'getsenv(game.Players.LocalPlayer.PlayerScripts.Main).update', 'getrawmetatable(game).__namecall', or 'getconnections(game.Workspace.Part.Touched)[1].Function'. Evaluated as `return <functionPath>`.",
      ),
    includeConstants: z
      .boolean()
      .describe("Include the function's constants table (default true).")
      .optional()
      .default(true),
    includeUpvalues: z
      .boolean()
      .describe("Include the function's upvalues — its captured variables (default true).")
      .optional()
      .default(true),
    threadContext: z.number().int().optional(),
  }),
  async execute({ functionPath, includeConstants, includeUpvalues, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end

local result = { Target = ${q(functionPath)}, Info = __fnInfo(fn) }

if ${includeConstants ? "true" : "false"} and type(__getconstants) == "function" then
  local ok, c = pcall(__getconstants, fn)
  if ok and type(c) == "table" then
    local list = {}
    for i, v in ipairs(c) do list[i] = { Index = i, Type = typeof(v), Value = __encVal(v) } end
    result.Constants = list
    result.ConstantCount = #c
  end
end

if ${includeUpvalues ? "true" : "false"} and type(__getupvalues) == "function" then
  local ok, u = pcall(__getupvalues, fn)
  if ok and type(u) == "table" then
    local list = {}
    for i, v in ipairs(u) do list[i] = { Index = i, Type = typeof(v), Value = __encVal(v) } end
    result.Upvalues = list
    result.UpvalueCount = #u
  end
end

if type(__getprotos) == "function" then
  local ok, p = pcall(__getprotos, fn)
  if ok and type(p) == "table" then result.ProtoCount = #p end
end

if type(getfunctionhash) == "function" then
  local ok, h = pcall(getfunctionhash, fn)
  if ok then result.FunctionHash = tostring(h) end
end

return result
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
