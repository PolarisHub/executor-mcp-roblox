import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "get-function-protos",
  title: "Get function protos",
  description: "Find a function by query and dump nested proto debug info.",
  category: "Reverse Engineering",
  input: z.object({
    query: z.string(),
    maxProtos: z.number().optional().default(30),
    threadContext: z.number().int().optional(),
  }),
  async execute({ query, maxProtos, threadContext }, ctx) {
    const source = `
assert(type(getgc) == "function", "getgc unavailable")
assert(type(debug) == "table" and type(debug.getinfo) == "function", "debug.getinfo unavailable")
assert(type(debug.getprotos) == "function", "debug.getprotos unavailable")
local q = string.lower(${q(query)})
local cap = math.max(1, math.min(500, ${Math.floor(maxProtos)}))
for _, fn in ipairs(getgc(true)) do
  if type(fn) == "function" then
    local okInfo, info = pcall(debug.getinfo, fn, "nSlu")
    if okInfo and info then
      local name = string.lower(tostring(info.name or ""))
      local src = string.lower(tostring(info.source or ""))
      if string.find(name, q, 1, true) or string.find(src, q, 1, true) then
        local okP, protos = pcall(debug.getprotos, fn)
        if okP and type(protos) == "table" then
          local out = {}
          for i, p in ipairs(protos) do
            if i > cap then break end
            local okPi, pi = pcall(debug.getinfo, p, "nSlu")
            table.insert(out, {
              Index = i,
              Name = (okPi and pi and pi.name) or "<anonymous>",
              Source = (okPi and pi and pi.source) or "",
              LineDefined = (okPi and pi and pi.linedefined) or -1,
              Pointer = tostring(p),
            })
          end
          return {
            Parent = { Name = info.name or "<anonymous>", Source = info.source or "", LineDefined = info.linedefined or -1, Pointer = tostring(fn) },
            ProtoCount = #protos,
            Protos = out,
          }
        end
      end
    end
  end
end
return { error = "No matching function with protos found." }`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
