import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "scan-proto-functions",
  title: "Scan proto functions",
  description: "Use debug.getprotos over matched functions and return proto summaries.",
  category: "Reverse Engineering",
  input: z.object({
    query: z.string().optional().default(""),
    limit: z.number().optional().default(100),
    threadContext: z.number().int().optional(),
  }),
  async execute({ query, limit, threadContext }, ctx) {
    const source = `
assert(type(getgc) == "function", "getgc unavailable")
assert(type(debug) == "table" and type(debug.getinfo) == "function", "debug.getinfo unavailable")
assert(type(debug.getprotos) == "function", "debug.getprotos unavailable")
local q = string.lower(${q(query)})
local max = math.max(1, math.min(1000, ${Math.floor(limit)}))
local out = {}
for _, fn in ipairs(getgc(true)) do
  if type(fn) == "function" then
    local okInfo, info = pcall(debug.getinfo, fn, "nSlu")
    if okInfo and info and info.what ~= "C" then
      local name = string.lower(tostring(info.name or ""))
      local src = string.lower(tostring(info.source or ""))
      if q == "" or string.find(name, q, 1, true) or string.find(src, q, 1, true) then
        local okP, protos = pcall(debug.getprotos, fn)
        if okP and type(protos) == "table" and #protos > 0 then
          table.insert(out, {
            Name = info.name or "<anonymous>",
            Source = info.source or "",
            LineDefined = info.linedefined or -1,
            ProtoCount = #protos,
            Pointer = tostring(fn),
          })
          if #out >= max then break end
        end
      end
    end
  end
end
table.sort(out, function(a,b) return a.ProtoCount > b.ProtoCount end)
return { query = q, count = #out, results = out }`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
