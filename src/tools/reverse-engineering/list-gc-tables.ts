import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "list-gc-tables",
  title: "List GC tables",
  description: "Enumerate table objects from getgc(true) with optional key/value query matching.",
  category: "Reverse Engineering",
  input: z.object({
    query: z.string().optional().default(""),
    limit: z.number().optional().default(100),
    threadContext: z.number().int().optional(),
  }),
  async execute({ query, limit, threadContext }, ctx) {
    const source = `
local getgcFn = getgc
if type(getgcFn) ~= "function" then return { error = "getgc unavailable" } end
local query = string.lower(${q(query)})
local limit = math.max(1, math.min(1000, ${Math.floor(limit)}))
local out = {}
for _, obj in ipairs(getgcFn(true)) do
  if type(obj) == "table" then
    if #out >= limit then break end
    local keyCount = 0
    local matched = (query == "")
    for k, v in pairs(obj) do
      keyCount = keyCount + 1
      if query ~= "" then
        local ks, vs = string.lower(tostring(k)), string.lower(tostring(v))
        if string.find(ks, query, 1, true) or string.find(vs, query, 1, true) then matched = true end
      end
      if keyCount > 2000 then break end
    end
    if matched then
      table.insert(out, { TablePointer = tostring(obj), KeyCount = keyCount })
    end
  end
end
return { count = #out, results = out }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
