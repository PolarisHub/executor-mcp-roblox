import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "find-module-scripts",
  title: "Find module scripts",
  description: "Search ModuleScripts by substring against name/full path.",
  category: "Reverse Engineering",
  input: z.object({
    query: z.string(),
    limit: z.number().optional().default(200),
    threadContext: z.number().int().optional(),
  }),
  async execute({ query, limit, threadContext }, ctx) {
    const source = `
local q = string.lower(${q(query)})
local limit = math.max(1, math.min(2000, ${Math.floor(limit)}))
local out = {}
for _, v in ipairs(game:GetDescendants()) do
  if v:IsA("ModuleScript") then
    local n = string.lower(v.Name)
    local p = string.lower(v:GetFullName())
    if string.find(n, q, 1, true) or string.find(p, q, 1, true) then
      table.insert(out, { Name = v.Name, Path = v:GetFullName(), DebugId = v:GetDebugId() })
      if #out >= limit then break end
    end
  end
end
return { count = #out, query = q, results = out }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
