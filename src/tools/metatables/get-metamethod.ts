import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-metamethod",
  title: "Read a single metamethod off an object's raw metatable",
  description:
    "Resolve a Luau expression to ANY value (table, Instance, userdata, etc.), grab its raw metatable via " +
    "getrawmetatable (bypassing __metatable locks), and read ONE named metamethod from it (e.g. __index, " +
    "__namecall, __newindex, __call, __tostring). When the metamethod is a function this deep-dumps it: its " +
    "info (Lua/C, source, line, params, upvalue count via getinfo) PLUS its constants (getconstants) and upvalues " +
    "(getupvalues). This is the targeted counterpart to get-metatable: use it to drill into the exact function " +
    "Roblox's security layer routes through — for example reading __namecall off getrawmetatable(game) to find the " +
    "C closure that backs FireServer/InvokeServer, then inspecting its constants for method-name strings. For " +
    "non-function metamethods (locked __metatable strings, __index tables, etc.) it returns the encoded value. " +
    "Requires getrawmetatable; getconstants/getupvalues are best-effort (omitted if the executor lacks them or " +
    "the metamethod is a C closure). Returns { Target, Method, Type, Function?, Constants?, Upvalues?, Value? } or " +
    "{ error } when there is no metatable, the method is absent, or getrawmetatable is missing.",
  category: "Metatables & Closures",
  input: z.object({
    objectPath: z
      .string()
      .describe(
        "Luau expression resolving to the object whose metatable holds the metamethod, e.g. 'game', " +
          "'game.Players.LocalPlayer', 'getrawmetatable(game)', or 'getgenv().SomeProxy'. Evaluated as `return <objectPath>`.",
      ),
    method: z
      .string()
      .describe(
        "Name of the metamethod key to read from the raw metatable, e.g. '__index', '__namecall', '__newindex', " +
          "'__call', '__tostring', '__metatable'. Read off the metatable as mt[method] (does NOT invoke it).",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ objectPath, method, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(__getrawmt) ~= "function" then return { error = "getrawmetatable is not available in this executor." } end
local obj, err = __eval(${q(objectPath)})
if err then return { error = err } end

local okMt, mt = pcall(__getrawmt, obj)
if not okMt then return { error = "getrawmetatable failed: " .. tostring(mt) } end
if mt == nil then return { error = "object has no metatable: " .. ${q(objectPath)} } end
if type(mt) ~= "table" then return { error = "raw metatable is not a table (got " .. typeof(mt) .. ")" } end

local okV, value = pcall(function() return mt[${q(method)}] end)
if not okV then return { error = "failed to read metamethod " .. ${q(method)} .. ": " .. tostring(value) } end
if value == nil then return { error = "metamethod " .. ${q(method)} .. " is not present on the metatable of " .. ${q(objectPath)} } end

local result = {
  Target = ${q(objectPath)},
  Method = ${q(method)},
  Type = typeof(value),
}

if type(value) == "function" then
  result.Function = __fnInfo(value)

  if type(__getconstants) == "function" then
    local okC, c = pcall(__getconstants, value)
    if okC and type(c) == "table" then
      local list = {}
      for i, v in ipairs(c) do list[i] = { Index = i, Type = typeof(v), Value = __encVal(v) } end
      result.Constants = list
      result.ConstantCount = #c
    end
  end

  if type(__getupvalues) == "function" then
    local okU, u = pcall(__getupvalues, value)
    if okU and type(u) == "table" then
      local list = {}
      for i, v in ipairs(u) do list[i] = { Index = i, Type = typeof(v), Value = __encVal(v) } end
      result.Upvalues = list
      result.UpvalueCount = #u
    end
  end
else
  result.Value = __encVal(value)
end

return result
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
