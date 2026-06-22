import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "find-bytecode-size-outliers",
  title: "Find bytecode size outliers",
  description:
    "Scan scripts and rank by getscriptbytecode size to find complex/high-value targets quickly.",
  category: "Reverse Engineering",
  input: z.object({
    limit: z.number().optional().default(100),
    includeModules: z.boolean().optional().default(true),
    includeLocalScripts: z.boolean().optional().default(true),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, includeModules, includeLocalScripts, threadContext }, ctx) {
    const source = `
assert(type(getscriptbytecode) == "function", "getscriptbytecode unavailable")
local cap = math.max(1, math.min(2000, ${Math.floor(limit)}))
local includeModules = ${includeModules ? "true" : "false"}
local includeLocalScripts = ${includeLocalScripts ? "true" : "false"}
local out = {}
for _, v in ipairs(game:GetDescendants()) do
  local okType = (includeModules and v:IsA("ModuleScript")) or (includeLocalScripts and v:IsA("LocalScript"))
  if okType then
    local ok, bc = pcall(getscriptbytecode, v)
    if ok and type(bc) == "string" then
      out[#out+1] = { Path = v:GetFullName(), ClassName = v.ClassName, BytecodeSize = #bc, DebugId = v:GetDebugId() }
    end
  end
end
table.sort(out, function(a,b) return a.BytecodeSize > b.BytecodeSize end)
local trimmed = {}
for i = 1, math.min(cap, #out) do trimmed[i] = out[i] end
return { count = #trimmed, results = trimmed }`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 60000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
