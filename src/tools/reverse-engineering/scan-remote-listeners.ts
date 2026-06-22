import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "scan-remote-listeners",
  title: "Scan remote listeners",
  description: "List RemoteEvent/RemoteFunction objects and listener counts from connection APIs.",
  category: "Reverse Engineering",
  input: z.object({
    limit: z.number().optional().default(300),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, threadContext }, ctx) {
    const source = `
assert(type(getconnections) == "function", "getconnections unavailable")
local max = math.max(1, math.min(5000, ${Math.floor(limit)}))
local out = {}
for _, v in ipairs(game:GetDescendants()) do
  local isEvt = v:IsA("RemoteEvent")
  local isFn = v:IsA("RemoteFunction")
  if isEvt or isFn then
    local c1, c2 = 0, 0
    if isEvt then
      pcall(function() c1 = #(getconnections(v.OnClientEvent) or {}) end)
    else
      pcall(function() c1 = #(getconnections(v.RemoteOnInvokeClient) or {}) end)
    end
    table.insert(out, { Name = v.Name, Path = v:GetFullName(), ClassName = v.ClassName, ListenerCount = c1, DebugId = v:GetDebugId() })
    if #out >= max then break end
  end
end
return { count = #out, results = out }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
