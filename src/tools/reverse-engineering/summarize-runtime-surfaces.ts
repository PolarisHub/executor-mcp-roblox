import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "summarize-runtime-surfaces",
  title: "Summarize runtime surfaces",
  description:
    "Quick high-level reverse summary: counts for scripts/modules/remotes/actors/functions/tables/threads.",
  category: "Reverse Engineering",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
local summary = {
  modules = 0,
  localscripts = 0,
  scripts = 0,
  remotes = 0,
  actors = 0,
  gcFunctions = 0,
  gcTables = 0,
  gcThreads = 0,
}
for _, v in ipairs(game:GetDescendants()) do
  if v:IsA("ModuleScript") then summary.modules = summary.modules + 1 end
  if v:IsA("LocalScript") then summary.localscripts = summary.localscripts + 1 end
  if v:IsA("Script") then summary.scripts = summary.scripts + 1 end
  if v:IsA("RemoteEvent") or v:IsA("RemoteFunction") then summary.remotes = summary.remotes + 1 end
  if v:IsA("Actor") then summary.actors = summary.actors + 1 end
end
if type(getgc) == "function" then
  for _, obj in ipairs(getgc(true)) do
    local t = type(obj)
    if t == "function" then summary.gcFunctions = summary.gcFunctions + 1
    elseif t == "table" then summary.gcTables = summary.gcTables + 1
    elseif t == "thread" then summary.gcThreads = summary.gcThreads + 1
    end
  end
end
return summary`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
