import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "inspect-instance-metatable",
  title: "Inspect instance metatable",
  description: "Get metatable keys from a target Instance path (e.g., game.Players.LocalPlayer).",
  category: "Reverse Engineering",
  input: z.object({
    instancePath: z.string(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, threadContext }, ctx) {
    const source = `
local inst = loadstring("return " .. ${q(instancePath)})()
assert(typeof(inst) == "Instance", "instancePath did not resolve to Instance")
local okMt, mt = pcall(function() return getrawmetatable and getrawmetatable(inst) or getmetatable(inst) end)
if not okMt then return { error = "Failed to read metatable: " .. tostring(mt) } end
if type(mt) ~= "table" then return { error = "Metatable is not a table (got " .. type(mt) .. "); it may be protected/locked." } end
local keys = {}
for k, v in pairs(mt) do
  if #keys >= 300 then break end
  table.insert(keys, { Key = tostring(k), Type = typeof and typeof(v) or type(v), Value = tostring(v) })
end
return { Instance = inst:GetFullName(), KeyCount = #keys, Keys = keys }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
