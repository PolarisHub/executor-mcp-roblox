import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "find-functions-by-constant",
  title: "Find functions by constant",
  description:
    "Scan getgc() and find closures whose constants contain a target string/number. Useful for locating handlers and hidden logic by magic constants.",
  category: "Reverse Engineering",
  input: z.object({
    constantQuery: z.string().describe("Case-insensitive constant substring to search for."),
    limit: z
      .number()
      .describe("Maximum number of matched functions to return (default: 30).")
      .optional()
      .default(30),
    includeCClosures: z
      .boolean()
      .describe("Include C closures (default: false).")
      .optional()
      .default(false),
    threadContext: z.number().int().optional(),
  }),
  async execute({ constantQuery, limit, includeCClosures, threadContext }, ctx) {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 300);
    const source = `
local function contains(haystack, needle)
  haystack = string.lower(tostring(haystack or ""))
  needle = string.lower(needle)
  return string.find(haystack, needle, 1, true) ~= nil
end

local getgcFn = getgc
if type(getgcFn) ~= "function" then
  return { error = "getgc is not available in this executor." }
end
if type(debug) ~= "table" or type(debug.getinfo) ~= "function" then
  return { error = "debug.getinfo is not available in this executor." }
end
if type(debug.getconstants) ~= "function" then
  return { error = "debug.getconstants is not available in this executor." }
end

local needle = ${q(constantQuery)}
local maxResults = ${safeLimit}
local includeC = ${includeCClosures ? "true" : "false"}

local scanned = 0
local results = {}
for _, obj in ipairs(getgcFn(true)) do
  if type(obj) == "function" then
    scanned = scanned + 1
    local okInfo, info = pcall(debug.getinfo, obj, "nSlu")
    if okInfo and info and (includeC or info.what ~= "C") then
      local okConsts, constants = pcall(debug.getconstants, obj)
      if okConsts and type(constants) == "table" then
        local hit = false
        local hitCount = 0
        local preview = {}
        for i, c in ipairs(constants) do
          local text = tostring(c)
          if contains(text, needle) then
            hit = true
            hitCount = hitCount + 1
          end
          if #preview < 12 then preview[#preview + 1] = text end
          if i >= 512 then break end
        end
        if hit then
          table.insert(results, {
            Name = info.name or "<anonymous>",
            Source = info.source or "",
            ShortSource = info.short_src or "",
            LineDefined = info.linedefined or -1,
            ConstantHits = hitCount,
            ConstantsPreview = preview,
            FunctionPointer = tostring(obj),
          })
          if #results >= maxResults then break end
        end
      end
    end
  end
end

table.sort(results, function(a, b)
  if a.ConstantHits == b.ConstantHits then
    return tostring(a.Source) < tostring(b.Source)
  end
  return a.ConstantHits > b.ConstantHits
end)

return {
  constantQuery = needle,
  scanned = scanned,
  returned = #results,
  results = results,
}
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
