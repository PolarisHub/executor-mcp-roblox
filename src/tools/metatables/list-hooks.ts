import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "list-hooks",
  title: "List active hooks installed via this MCP",
  description:
    "List every function/metamethod hook installed through hook-function / hook-metamethod in this session. Each " +
    "entry shows the key (pass it to restore-hook to undo), the kind (function or metamethod), the target " +
    "expression, the metamethod name (if any), and the type of the stored original. Use this to audit what you've " +
    "hooked before restoring — important because hooks are global and persistent. Reads getgenv().__mcp_hooks.",
  category: "Metatables & Closures",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor." } end
local genv = getgenv()
local hooks = genv.__mcp_hooks or {}
local meta = genv.__mcp_hook_meta or {}
local list = {}
for k, v in pairs(hooks) do
  local m = meta[k] or {}
  list[#list + 1] = {
    Key = tostring(k),
    Kind = m.kind or "unknown",
    TargetExpr = m.targetExpr,
    Method = m.method,
    OriginalType = typeof(v),
  }
end
return { Count = #list, Hooks = list }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 15000 });
    return { data };
  },
});
