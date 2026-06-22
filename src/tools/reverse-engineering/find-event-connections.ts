import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "find-event-connections",
  title: "Find event connections",
  description: "Inspect RBXScriptSignal connections by instance path + signal name.",
  category: "Reverse Engineering",
  input: z.object({
    instancePath: z.string(),
    signalName: z.string(),
    limit: z.number().optional().default(100),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, signalName, limit, threadContext }, ctx) {
    const source = `
assert(type(getconnections) == "function", "getconnections unavailable")
local inst = loadstring("return " .. ${q(instancePath)})()
assert(typeof(inst) == "Instance", "instancePath did not resolve to Instance")
local okSignal, signal = pcall(function() return inst[${q(signalName)}] end)
if not okSignal then return { error = "Signal " .. ${q(signalName)} .. " not found on instance " .. inst:GetFullName() } end
if typeof(signal) ~= "RBXScriptSignal" then return { error = "signalName " .. ${q(signalName)} .. " did not resolve to RBXScriptSignal (got " .. (typeof(signal)) .. ")" } end
local limit = math.max(1, math.min(1000, ${Math.floor(limit)}))
local out = {}
for _, conn in ipairs(getconnections(signal)) do
  if #out >= limit then break end
  table.insert(out, {
    Enabled = conn.Enabled,
    ForeignState = conn.ForeignState,
    LuaConnection = conn.LuaConnection,
    Function = tostring(conn.Function),
    Thread = tostring(conn.Thread),
  })
end
return { instance = inst:GetFullName(), signal = ${q(signalName)}, count = #out, results = out }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
