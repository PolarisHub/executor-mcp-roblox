import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "disassemble-function",
  title: "Disassemble function (IDA-style function view)",
  description:
    "Produce a full IDA-style dump of a single Luau function in one call: debug.info (name/source/line/params/ups), " +
    "whether it is a Lua or C closure (islclosure/iscclosure), constant/upvalue/proto counts, the executor function " +
    "hash (getfunctionhash) for duplicate-detection, and — optionally — the full constant and upvalue tables with " +
    "their typeof and a string value (Instances become GetFullName, functions become tostring). Complements " +
    "inspect-closure by bundling the hash and the structural counts into one reverse-engineering-focused view. Resolve " +
    "the target via a Luau expression that yields a function; each list is capped at 200 entries.",
  category: "Disassembly & Xrefs",
  input: z.object({
    functionPath: z
      .string()
      .describe(
        'Luau expression that resolves to the function to disassemble (e.g. "getgenv().myFunc" or ' +
          '"require(game.ReplicatedStorage.Mod).start"). Evaluated as `return <expr>`; must yield a function.',
      ),
    includeConstants: z
      .boolean()
      .describe(
        "Include the full constants table (capped at 200) with Index/Type/Value. Default true.",
      )
      .optional()
      .default(true),
    includeUpvalues: z
      .boolean()
      .describe(
        "Include the full upvalues table (capped at 200) with Index/Type/Value. Default true.",
      )
      .optional()
      .default(true),
    threadContext: z.number().int().optional(),
  }),
  async execute({ functionPath, includeConstants, includeUpvalues, threadContext }, ctx) {
    const source = `
${XREF_PRELUDE}
local ok, fn = pcall(function() return (loadstring("return " .. ${q(functionPath)}))() end)
if not ok or type(fn) ~= "function" then
  return { error = "functionPath did not resolve to a function: " .. ${q(functionPath)} }
end

local function __valStr(v)
  local t = typeof(v)
  if t == "Instance" then
    local okn, n = pcall(function() return v:GetFullName() end)
    if okn then return n end
    return tostring(v)
  end
  local oks, s = pcall(tostring, v)
  if oks then return s end
  return "<unprintable>"
end

local function __dumpList(list)
  local out = {}
  for i = 1, math.min(#list, 200) do
    local v = list[i]
    out[i] = { Index = i, Type = typeof(v), Value = __valStr(v) }
  end
  return out
end

local consts = __consts(fn)
local ups = __ups(fn)
local protos = __protos(fn)

local isLua = nil
if type(islclosure) == "function" then
  local oki, r = pcall(islclosure, fn); if oki then isLua = r end
end
local isC = nil
if type(iscclosure) == "function" then
  local okc, r = pcall(iscclosure, fn); if okc then isC = r end
end

local hash = nil
if type(getfunctionhash) == "function" then
  local okh, h = pcall(getfunctionhash, fn); if okh then hash = tostring(h) end
end

local result = {
  Info = __fnInfo(fn),
  IsLua = isLua,
  IsC = isC,
  ConstantCount = #consts,
  UpvalueCount = #ups,
  ProtoCount = #protos,
  FunctionHash = hash,
}

if ${includeConstants ? "true" : "false"} then result.Constants = __dumpList(consts) end
if ${includeUpvalues ? "true" : "false"} then result.Upvalues = __dumpList(ups) end

return result
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
