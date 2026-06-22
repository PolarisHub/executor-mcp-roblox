import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "list-script-actors",
  title: "List script actors",
  description:
    "List Actor instances and contained LuaSourceContainer scripts for actor-based reverse analysis.",
  category: "Reverse Engineering",
  input: z.object({
    limit: z.number().optional().default(250),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, threadContext }, ctx) {
    const source = `
local cap = math.max(1, math.min(5000, ${Math.floor(limit)}))
local out = {}
for _, actor in ipairs(game:GetDescendants()) do
  if actor:IsA("Actor") then
    local scripts = {}
    for _, d in ipairs(actor:GetDescendants()) do
      if d:IsA("LuaSourceContainer") then
        scripts[#scripts+1] = d:GetFullName()
        if #scripts >= 40 then break end
      end
    end
    out[#out+1] = { ActorPath = actor:GetFullName(), ScriptCount = #scripts, Scripts = scripts }
    if #out >= cap then break end
  end
end
return { count = #out, results = out }`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
