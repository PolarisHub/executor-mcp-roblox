import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "scan-hook-surfaces",
  title: "Scan hook surfaces",
  description: "Check availability of common exploit/debug hook APIs and return capability map.",
  category: "Reverse Engineering",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
local names = {
  "hookfunction","hookmetamethod","getrawmetatable","setreadonly","islclosure","iscclosure",
  "getgc","getreg","getregistry","getconnections","getupvalues","getupvalue","getconstants",
  "getprotos","getfenv","setfenv","decompile","getscriptbytecode"
}
local out = {}
for _, n in ipairs(names) do
  local v = _G[n]
  out[#out+1] = { Name = n, Available = type(v) == "function", Type = type(v) }
end
return { count = #out, results = out }`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
