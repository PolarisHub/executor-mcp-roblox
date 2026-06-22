import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "trace-require-callers",
  title: "Trace require callers",
  description: "Find functions that reference 'require' in constants/source via getgc scan.",
  category: "Reverse Engineering",
  input: z.object({
    limit: z.number().optional().default(80),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, threadContext }, ctx) {
    const source = `
if type(getgc) ~= "function" then return { error = "getgc unavailable" } end
if type(debug) ~= "table" or type(debug.getinfo) ~= "function" then return { error = "debug.getinfo unavailable" } end
local max = math.max(1, math.min(500, ${Math.floor(limit)}))
local out = {}
for _, fn in ipairs(getgc(true)) do
  if type(fn) == "function" then
    local okInfo, info = pcall(debug.getinfo, fn, "nSlu")
    if okInfo and info and info.what ~= "C" then
      local matched = false
      if string.find(string.lower(tostring(info.source or "")), "require", 1, true) then matched = true end
      if not matched and type(debug.getconstants) == "function" then
        local okC, c = pcall(debug.getconstants, fn)
        if okC and type(c) == "table" then
          for _, v in ipairs(c) do
            if string.find(string.lower(tostring(v)), "require", 1, true) then matched = true break end
          end
        end
      end
      if matched then
        table.insert(out, { Name = info.name or "<anonymous>", Source = info.source or "", LineDefined = info.linedefined or -1, Pointer = tostring(fn) })
        if #out >= max then break end
      end
    end
  end
end
return { count = #out, results = out }`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
