import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "find-constants-xref",
  title: "Find constants xref",
  description: "Find getgc functions containing a target constant and return compact xrefs.",
  category: "Reverse Engineering",
  input: z.object({
    constantQuery: z.string(),
    limit: z.number().optional().default(120),
    threadContext: z.number().int().optional(),
  }),
  async execute({ constantQuery, limit, threadContext }, ctx) {
    const source = `
assert(type(getgc) == "function", "getgc unavailable")
assert(type(debug) == "table" and type(debug.getinfo) == "function", "debug.getinfo unavailable")
assert(type(debug.getconstants) == "function", "debug.getconstants unavailable")
local q = string.lower(${q(constantQuery)})
local max = math.max(1, math.min(2000, ${Math.floor(limit)}))
local out = {}
for _, fn in ipairs(getgc(true)) do
  if type(fn) == "function" then
    local okc, constants = pcall(debug.getconstants, fn)
    if okc and type(constants) == "table" then
      local hits = 0
      for _, c in ipairs(constants) do
        if string.find(string.lower(tostring(c)), q, 1, true) then hits = hits + 1 end
      end
      if hits > 0 then
        local oki, info = pcall(debug.getinfo, fn, "nSlu")
        table.insert(out, {
          Name = (oki and info and info.name) or "<anonymous>",
          Source = (oki and info and info.source) or "",
          LineDefined = (oki and info and info.linedefined) or -1,
          HitCount = hits,
          Pointer = tostring(fn)
        })
        if #out >= max then break end
      end
    end
  end
end
table.sort(out, function(a,b) return a.HitCount > b.HitCount end)
return { query = q, count = #out, results = out }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
