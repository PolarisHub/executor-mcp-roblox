import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "scan-network-endpoints",
  title: "Scan network endpoints",
  description: "Find URL-like strings in function constants across getgc closures.",
  category: "Reverse Engineering",
  input: z.object({
    limit: z.number().optional().default(200),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, threadContext }, ctx) {
    const source = `
assert(type(getgc) == "function", "getgc unavailable")
assert(type(debug) == "table" and type(debug.getconstants) == "function" and type(debug.getinfo) == "function", "required debug APIs unavailable")
local cap = math.max(1, math.min(2000, ${Math.floor(limit)}))
local out = {}
for _, fn in ipairs(getgc(true)) do
  if type(fn) == "function" then
    local okC, constants = pcall(debug.getconstants, fn)
    if okC and type(constants) == "table" then
      for _, c in ipairs(constants) do
        local s = tostring(c)
        local url = string.match(s, "https?://[%w%.%-_/%%?=&:#]+")
        if url then
          local okI, info = pcall(debug.getinfo, fn, "nSlu")
          out[#out+1] = {
            Url = url,
            Function = (okI and info and info.name) or "<anonymous>",
            Source = (okI and info and info.source) or "",
            LineDefined = (okI and info and info.linedefined) or -1,
          }
          if #out >= cap then
            return { count = #out, results = out }
          end
        end
      end
    end
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
