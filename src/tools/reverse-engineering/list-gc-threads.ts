import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "list-gc-threads",
  title: "List GC threads",
  description:
    "Enumerate thread objects from getgc(true), including coroutine status where available.",
  category: "Reverse Engineering",
  input: z.object({
    limit: z.number().optional().default(150),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, threadContext }, ctx) {
    const source = `
local getgcFn = getgc
if type(getgcFn) ~= "function" then return { error = "getgc unavailable" } end
local limit = math.max(1, math.min(1000, ${Math.floor(limit)}))
local out = {}
for _, obj in ipairs(getgcFn(true)) do
  if type(obj) == "thread" then
    if #out >= limit then break end
    local ok, status = pcall(coroutine.status, obj)
    table.insert(out, { ThreadPointer = tostring(obj), Status = ok and status or "unknown" })
  end
end
return { count = #out, results = out }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
