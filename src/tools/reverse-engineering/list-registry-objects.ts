import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "list-registry-objects",
  title: "List registry objects",
  description: "Inspect debug.getregistry() and summarize object types for runtime reversing.",
  category: "Reverse Engineering",
  input: z.object({ threadContext: z.number().int().optional() }),
  async execute({ threadContext }, ctx) {
    const source = `
if type(debug) ~= "table" or type(debug.getregistry) ~= "function" then return { error = "debug.getregistry unavailable" } end
local reg = debug.getregistry()
local counts = {}
local sample = {}
local i = 0
for k, v in pairs(reg) do
  i = i + 1
  local t = typeof and typeof(v) or type(v)
  counts[t] = (counts[t] or 0) + 1
  if #sample < 80 then
    table.insert(sample, { Key = tostring(k), Type = t, Value = tostring(v) })
  end
  if i > 50000 then break end
end
return { totalScanned = i, typeCounts = counts, sample = sample }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
