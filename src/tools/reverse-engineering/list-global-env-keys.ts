import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "list-global-env-keys",
  title: "List global env keys",
  description: "List keys from getgenv/_G with type/value previews.",
  category: "Reverse Engineering",
  input: z.object({
    query: z.string().optional().default(""),
    limit: z.number().optional().default(300),
    threadContext: z.number().int().optional(),
  }),
  async execute({ query, limit, threadContext }, ctx) {
    const source = `
local env = (getgenv and getgenv()) or _G
local q = string.lower(${q(query)})
local cap = math.max(1, math.min(5000, ${Math.floor(limit)}))
local out = {}
for k, v in pairs(env) do
  if #out >= cap then break end
  local ks = string.lower(tostring(k))
  if q == "" or string.find(ks, q, 1, true) then
    out[#out+1] = { Key = tostring(k), Type = typeof and typeof(v) or type(v), Value = tostring(v) }
  end
end
return { count = #out, results = out }`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
