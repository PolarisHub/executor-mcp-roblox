import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "find-upvalue-xref",
  title: "Find upvalue xref",
  description: "Find functions whose upvalue names or values match a query.",
  category: "Reverse Engineering",
  input: z.object({
    query: z.string(),
    limit: z.number().optional().default(80),
    threadContext: z.number().int().optional(),
  }),
  async execute({ query, limit, threadContext }, ctx) {
    const source = `
assert(type(getgc) == "function", "getgc unavailable")
assert(type(debug) == "table" and (type(debug.getupvalue) == "function" or type(debug.getupvalues) == "function"), "debug upvalue APIs unavailable")
assert(type(debug.getinfo) == "function", "debug.getinfo unavailable")
local q = string.lower(${q(query)})
local max = math.max(1, math.min(1000, ${Math.floor(limit)}))
local out = {}
for _, fn in ipairs(getgc(true)) do
  if type(fn) == "function" then
    local matched = false
    local preview = {}
    if type(debug.getupvalue) == "function" then
      for i = 1, 100 do
        local ok, n, v = pcall(debug.getupvalue, fn, i)
        if not ok or n == nil then break end
        local ns = string.lower(tostring(n))
        local vs = string.lower(tostring(v))
        if string.find(ns, q, 1, true) or string.find(vs, q, 1, true) then matched = true end
        if #preview < 10 then preview[#preview+1] = { Index = i, Name = tostring(n), Value = tostring(v) } end
      end
    end
    if matched then
      local okInfo, info = pcall(debug.getinfo, fn, "nSlu")
      table.insert(out, {
        Name = (okInfo and info and info.name) or "<anonymous>",
        Source = (okInfo and info and info.source) or "",
        LineDefined = (okInfo and info and info.linedefined) or -1,
        Upvalues = preview,
        Pointer = tostring(fn),
      })
      if #out >= max then break end
    end
  end
end
return { query = q, count = #out, results = out }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
