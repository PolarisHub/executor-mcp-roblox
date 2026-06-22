import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "get-call-stack",
  title: "Walk the current Luau call stack (debug.info frames)",
  description:
    "Unwind the current Luau call stack from the executing thread and return one frame per level: { level, name, " +
    "source, line }. Walks debug.info(level, 'nsl') (name / source / currentline) from level 1 outward, stopping at " +
    "the first level that yields nil or after maxLevels frames. Use it to see who is calling the code you just ran — " +
    "the chain of functions leading into the current execution — which is invaluable when reasoning about a hook " +
    "callback or a deferred task's origin. " +
    "Requires debug.info (or debug.getinfo) — type-guarded and pcall-wrapped, returning { error } on an executor that " +
    "lacks it. Returns { frames } or { error }.",
  category: "Reverse Engineering",
  input: z.object({
    maxLevels: z
      .number()
      .int()
      .default(20)
      .describe("Maximum number of stack frames to walk before stopping (default 20)."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ maxLevels, threadContext, timeoutMs }, ctx) {
    const max = Math.min(Math.max(Math.floor(maxLevels), 1), 200);

    const source = `
local __info = (type(debug) == "table" and (debug.info or debug.getinfo)) or nil
if type(__info) ~= "function" then
  return { error = "debug.info is not available in this executor." }
end

local MAX = ${max}
local frames = {}

for level = 1, MAX do
  -- debug.info accepts (level, "nsl") and returns name, source, line in that order.
  local ok, a, b, c = pcall(__info, level, "nsl")
  if not ok then
    break
  end
  -- A level past the top of the stack returns no values (a is nil with nothing set).
  if a == nil and b == nil and c == nil then
    break
  end
  -- debug.getinfo returns a single table; debug.info returns multiple values.
  if type(a) == "table" then
    frames[#frames + 1] = {
      level = level,
      name = a.name,
      source = a.short_src or a.source,
      line = a.currentline or a.linedefined,
    }
  else
    frames[#frames + 1] = {
      level = level,
      name = (type(a) == "string" and a ~= "" and a) or nil,
      source = b,
      line = c,
    }
  end
end

return { frames = frames }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
