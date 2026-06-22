import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "list-runtime-modules",
  title: "List runtime modules",
  description: "Find ModuleScripts in game + nil instances and report metadata for reversing.",
  category: "Reverse Engineering",
  input: z.object({
    includeNil: z.boolean().optional().default(true),
    limit: z.number().optional().default(300),
    threadContext: z.number().int().optional(),
  }),
  async execute({ includeNil, limit, threadContext }, ctx) {
    const source = `
local limit = math.max(1, math.min(5000, ${Math.floor(limit)}))
local includeNil = ${includeNil ? "true" : "false"}
local out = {}
for _, v in ipairs(game:GetDescendants()) do
  if v:IsA("ModuleScript") then
    table.insert(out, { Name = v.Name, Path = v:GetFullName(), DebugId = v:GetDebugId() })
    if #out >= limit then return { count = #out, results = out } end
  end
end
if includeNil and type(getnilinstances) == "function" then
  for _, v in ipairs(getnilinstances()) do
    if typeof(v) == "Instance" and v:IsA("ModuleScript") then
      table.insert(out, { Name = v.Name, Path = "<nil>." .. v.Name, DebugId = v:GetDebugId() })
      if #out >= limit then break end
    end
  end
end
return { count = #out, results = out }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
