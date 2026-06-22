import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "list-rendered-instances",
  title: "getrendered — list instances currently being rendered",
  description:
    "Enumerate the instances the engine is currently rendering via getrendered() and return { count, samples }, where " +
    "each sample is { class, name, path }. This is the set of objects actually on screen this frame — useful for ESP/" +
    "render auditing, spotting which parts/GUIs are visible, or correlating a render spike with specific instances. The " +
    "full count is reported even though only a capped sample of entries is returned. " +
    "Requires getrendered — type-guarded and pcall-wrapped, returning { error } when missing or " +
    "on failure. Returns { count, truncated, samples } or { error }.",
  category: "Inspection",
  input: z.object({
    limit: z
      .number()
      .int()
      .default(100)
      .describe(
        "Maximum number of sample entries to return (default 100). The full count is always reported.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ limit, threadContext, timeoutMs }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 2000);

    const source = `
if type(getrendered) ~= "function" then
  return { error = "getrendered is not available in this executor." }
end

local ok, rendered = pcall(getrendered)
if not ok then
  return { error = "getrendered failed: " .. tostring(rendered) }
end
if type(rendered) ~= "table" then
  return { count = 0, truncated = false, samples = {} }
end

local LIMIT = ${lim}
local samples = {}
local count = 0
local truncated = false

for _, inst in rendered do
  count = count + 1
  if #samples < LIMIT then
    local entry = {}
    pcall(function() entry.class = inst.ClassName end)
    pcall(function() entry.name = inst.Name end)
    local okp, full = pcall(function() return inst:GetFullName() end)
    entry.path = okp and full or tostring(inst)
    samples[#samples + 1] = entry
  else
    truncated = true
  end
end

return { count = count, truncated = truncated, samples = samples }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
