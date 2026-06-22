import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "scan-closures-by-name",
  title: "Scan closures by name",
  description: "Find getgc closures whose debug name contains a target substring.",
  category: "Reverse Engineering",
  input: z.object({
    nameQuery: z.string(),
    limit: z.number().optional().default(200),
    includeCClosures: z.boolean().optional().default(false),
    threadContext: z.number().int().optional(),
  }),
  async execute({ nameQuery, limit, includeCClosures, threadContext }, ctx) {
    const source = `
assert(type(getgc) == "function", "getgc unavailable")
assert(type(debug) == "table" and type(debug.getinfo) == "function", "debug.getinfo unavailable")
local q = string.lower(${q(nameQuery)})
local cap = math.max(1, math.min(3000, ${Math.floor(limit)}))
local includeC = ${includeCClosures ? "true" : "false"}
local out = {}
for _, fn in ipairs(getgc(true)) do
  if type(fn) == "function" then
    local okI, info = pcall(debug.getinfo, fn, "nSlu")
    if okI and info and (includeC or info.what ~= "C") then
      local nm = string.lower(tostring(info.name or ""))
      if string.find(nm, q, 1, true) then
        out[#out+1] = {
          Name = info.name or "<anonymous>",
          Source = info.source or "",
          LineDefined = info.linedefined or -1,
          Pointer = tostring(fn),
        }
        if #out >= cap then break end
      end
    end
  end
end
return { query = q, count = #out, results = out }`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
