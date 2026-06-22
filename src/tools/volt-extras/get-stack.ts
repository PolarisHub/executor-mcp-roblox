import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { PRELUDE } from "../_shared/luau.js";

export default defineTool({
  name: "get-stack",
  title: "debug.getstack — read live Luau stack slots at a level",
  description:
    "Read the raw values currently sitting on the Luau stack at a given call level via the executor's debug.getstack. " +
    "Without 'index' it returns every live stack slot at that level as an encoded list (Instances/EnumItems/tables are " +
    "flattened to a JSON-friendly shape); with 'index' it returns just that one slot's encoded value. This exposes the " +
    "in-flight locals and temporaries of a running function — the values a frame is actively working with — letting you " +
    "snapshot what a callback or hooked function holds at the moment your code runs. " +
    "Requires debug.getstack — type-guarded and pcall-wrapped, returning { error } when missing " +
    "or on failure. Returns { level, index?, value } / { level, count, values } or { error }.",
  category: "Reverse Engineering",
  input: z.object({
    level: z
      .number()
      .int()
      .describe(
        "The call-stack level to read (1 = the function calling getstack, i.e. the executing chunk; higher = further " +
          "up the stack).",
      ),
    index: z
      .number()
      .int()
      .optional()
      .describe(
        "Optional 1-based stack slot index. When given, only that single slot is read and returned; when omitted, the " +
          "whole stack table at 'level' is returned.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ level, index, threadContext, timeoutMs }, ctx) {
    const lvl = Math.floor(level);
    const hasIndex = typeof index === "number" && Number.isFinite(index);
    const idx = hasIndex ? Math.floor(index) : undefined;

    const source = `
${PRELUDE}
if type(debug) ~= "table" or type(debug.getstack) ~= "function" then
  return { error = "debug.getstack is not available in this executor." }
end

local LEVEL = ${lvl}
${
  hasIndex
    ? `local INDEX = ${idx}
local ok, value = pcall(debug.getstack, LEVEL, INDEX)
if not ok then
  return { error = "debug.getstack failed: " .. tostring(value) }
end
return { level = LEVEL, index = INDEX, value = __encode(value) }`
    : `local ok, stack = pcall(debug.getstack, LEVEL)
if not ok then
  return { error = "debug.getstack failed: " .. tostring(stack) }
end
if type(stack) ~= "table" then
  return { level = LEVEL, count = 0, values = {} }
end
local values = {}
local count = 0
for i, v in pairs(stack) do
  count = count + 1
  values[#values + 1] = { index = i, value = __encode(v) }
end
return { level = LEVEL, count = count, values = values }`
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
