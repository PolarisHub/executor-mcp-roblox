import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "find-path-references",
  title: "Find path references",
  description:
    "Find constants containing instance path fragments like ReplicatedStorage/Workspace.",
  category: "Reverse Engineering",
  input: z.object({
    query: z.string(),
    limit: z.number().optional().default(150),
    threadContext: z.number().int().optional(),
  }),
  async execute({ query, limit, threadContext }, ctx) {
    const source = `
assert(type(getgc) == "function", "getgc unavailable")
assert(type(debug) == "table" and type(debug.getconstants) == "function" and type(debug.getinfo) == "function", "required debug APIs unavailable")
local q = string.lower(${q(query)})
local cap = math.max(1, math.min(2000, ${Math.floor(limit)}))
local out = {}
for _, fn in ipairs(getgc(true)) do
  if type(fn) == "function" then
    local okC, constants = pcall(debug.getconstants, fn)
    if okC and type(constants) == "table" then
      local hits = 0
      local firstMatch = nil
      for _, c in ipairs(constants) do
        local s = string.lower(tostring(c))
        if string.find(s, q, 1, true) then
          hits = hits + 1
          if firstMatch == nil then firstMatch = tostring(c) end
        end
      end
      if hits > 0 then
        local okI, info = pcall(debug.getinfo, fn, "nSlu")
        out[#out+1] = {
          Match = firstMatch,
          HitCount = hits,
          Function = (okI and info and info.name) or "<anonymous>",
          Source = (okI and info and info.source) or "",
          LineDefined = (okI and info and info.linedefined) or -1,
        }
        if #out >= cap then break end
      end
    end
  end
end
table.sort(out, function(a,b) return a.HitCount > b.HitCount end)
return { query = q, count = #out, results = out }`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
