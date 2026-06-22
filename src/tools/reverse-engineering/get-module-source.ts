import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "get-module-source",
  title: "Get module source",
  description: "Decompile a specific ModuleScript by path.",
  category: "Reverse Engineering",
  input: z.object({
    modulePath: z.string(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ modulePath, threadContext }, ctx) {
    const source = `
local mod = loadstring("return " .. ${q(modulePath)})()
assert(typeof(mod) == "Instance" and mod:IsA("ModuleScript"), "modulePath must resolve to ModuleScript")
local ok, src = pcall(function() return decompile(mod) end)
if not ok then return { error = tostring(src) } end
return { path = mod:GetFullName(), source = src }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 60000 });
    return { data };
  },
});
