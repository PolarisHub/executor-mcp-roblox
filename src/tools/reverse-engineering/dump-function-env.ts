import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "dump-function-env",
  title: "Dump function env",
  description: "Find function by query and inspect environment table keys/values.",
  category: "Reverse Engineering",
  input: z.object({
    query: z.string(),
    limit: z.number().optional().default(120),
    threadContext: z.number().int().optional(),
  }),
  async execute({ query, limit, threadContext }, ctx) {
    const source = `
assert(type(getgc) == "function", "getgc unavailable")
assert(type(debug) == "table" and type(debug.getinfo) == "function", "debug.getinfo unavailable")
local q = string.lower(${q(query)})
local cap = math.max(1, math.min(1000, ${Math.floor(limit)}))
for _, fn in ipairs(getgc(true)) do
  if type(fn) == "function" then
    local okInfo, info = pcall(debug.getinfo, fn, "nSlu")
    if okInfo and info then
      local name = string.lower(tostring(info.name or ""))
      local src = string.lower(tostring(info.source or ""))
      if string.find(name, q, 1, true) or string.find(src, q, 1, true) then
        local env = getfenv(fn)
        local out = {}
        local i = 0
        for k, v in pairs(env) do
          i = i + 1
          if #out >= cap then break end
          out[#out + 1] = { Key = tostring(k), Type = typeof and typeof(v) or type(v), Value = tostring(v) }
        end
        return {
          Function = { Name = info.name or "<anonymous>", Source = info.source or "", LineDefined = info.linedefined or -1, Pointer = tostring(fn) },
          EnvCount = i,
          Env = out,
        }
      end
    end
  end
end
return { error = "No matching function found." }`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
