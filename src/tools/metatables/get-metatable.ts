import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-metatable",
  title: "Get an object's raw metatable",
  description:
    "Resolve a Luau expression to ANY value (table, Instance, userdata, etc.) and dump its raw metatable via " +
    "getrawmetatable (bypassing __metatable locks). For each metamethod it reports the key, value type, and — for " +
    "function metamethods like __index/__namecall/__newindex — the connected function's source/line/params. Also " +
    "reports whether the metatable is read-only and whether getmetatable is locked (a string __metatable). Use this " +
    "to understand how a table/instance is protected or proxied, or to find the __namecall/__index that game " +
    "security routes through. Unlike inspect-instance-metatable this works on any value, not just Instances. " +
    "Requires getrawmetatable; returns { Target, TargetType, HasMetatable, ReadOnly, LockedMetatableValue, Metamethods } or { error }.",
  category: "Metatables & Closures",
  input: z.object({
    objectPath: z
      .string()
      .describe(
        "Luau expression resolving to the object whose metatable you want, e.g. 'game', 'game.Players.LocalPlayer', 'getrawmetatable(game)', or 'getgenv().SomeTable'. Evaluated as `return <objectPath>`.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ objectPath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(__getrawmt) ~= "function" then return { error = "getrawmetatable is not available in this executor." } end
local obj, err = __eval(${q(objectPath)})
if err then return { error = err } end

local okMt, mt = pcall(__getrawmt, obj)
if not okMt then return { error = "getrawmetatable failed: " .. tostring(mt) } end
if mt == nil then return { Target = ${q(objectPath)}, TargetType = typeof(obj), HasMetatable = false } end

local readonly = nil
if type(isreadonly) == "function" then local okR, r = pcall(isreadonly, mt); if okR then readonly = r end end
local locked = nil
if type(getmetatable) == "function" then
  local okG, g = pcall(getmetatable, obj)
  if okG and type(g) == "string" then locked = g end
end

local fields = {}
pcall(function()
  for k, v in pairs(mt) do
    local entry = { Key = tostring(k), Type = typeof(v) }
    if type(v) == "function" then entry.Function = __fnInfo(v) else entry.Value = __encVal(v) end
    fields[#fields + 1] = entry
  end
end)

return {
  Target = ${q(objectPath)},
  TargetType = typeof(obj),
  HasMetatable = true,
  ReadOnly = readonly,
  LockedMetatableValue = locked,
  MetamethodCount = #fields,
  Metamethods = fields,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
