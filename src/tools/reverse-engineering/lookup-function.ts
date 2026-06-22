import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "lookup-function",
  title: "Lookup function in getgc",
  description:
    "Search live functions by name/source/constant text and return enriched debug metadata for reverse engineering.",
  category: "Reverse Engineering",
  input: z.object({
    query: z.string().describe("Case-insensitive query to match against name/source/constants."),
    mode: z
      .enum(["name", "source", "constants", "both"])
      .describe("Where to match the query (default: both).")
      .optional()
      .default("both"),
    limit: z
      .number()
      .describe("Maximum number of functions to return (default: 25).")
      .optional()
      .default(25),
    includeCClosures: z
      .boolean()
      .describe("Include C closures from getgc (default: false).")
      .optional()
      .default(false),
    includeConstantsPreview: z
      .boolean()
      .describe("Include a small constants preview if available (default: true).")
      .optional()
      .default(true),
    threadContext: z.number().int().optional(),
  }),
  async execute(
    { query, mode, limit, includeCClosures, includeConstantsPreview, threadContext },
    ctx,
  ) {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 250);
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

local query = ${q(query)}
local mode = ${q(mode)}
local includeC = ${includeCClosures ? "true" : "false"}
local includeConstantsPreview = ${includeConstantsPreview ? "true" : "false"}
local maxResults = ${safeLimit}

local function constantMatches(fn)
  if type(debug.getconstants) ~= "function" then
    return false, {}
  end
  local ok, constants = pcall(debug.getconstants, fn)
  if not ok or type(constants) ~= "table" then
    return false, {}
  end
  local matched = false
  local preview = {}
  for i, c in ipairs(constants) do
    local text = tostring(c)
    if contains(text, query) then matched = true end
    if includeConstantsPreview and #preview < 12 then
      preview[#preview + 1] = text
    end
    if i >= 256 then break end
  end
  return matched, preview
end

local scanned = 0
local results = {}
for _, obj in ipairs(getgcFn(true)) do
  if type(obj) == "function" then
    scanned = scanned + 1
    local okInfo, info = pcall(debug.getinfo, obj, "nSlu")
    if okInfo and info then
      if includeC or info.what ~= "C" then
        local fnName = info.name or "<anonymous>"
        local src = info.source or ""
        local shortSrc = info.short_src or ""
        local matchName = contains(fnName, query)
        local matchSource = contains(src, query) or contains(shortSrc, query)
        local matchConst, preview = constantMatches(obj)
        local isMatch = false
        if mode == "name" then isMatch = matchName
        elseif mode == "source" then isMatch = matchSource
        elseif mode == "constants" then isMatch = matchConst
        else isMatch = matchName or matchSource or matchConst end

        if isMatch then
          local upCount = 0
          if type(debug.getupvalues) == "function" then
            local okUps, ups = pcall(debug.getupvalues, obj)
            if okUps and type(ups) == "table" then upCount = #ups end
          end

          table.insert(results, {
            Name = fnName,
            Source = src,
            ShortSource = shortSrc,
            LineDefined = info.linedefined or -1,
            LastLineDefined = info.lastlinedefined or -1,
            What = info.what or "?",
            NumParams = info.nparams or -1,
            IsVararg = info.isvararg == true,
            UpvalueCount = upCount,
            ConstantQueryMatched = matchConst,
            ConstantsPreview = preview,
            FunctionPointer = tostring(obj),
          })
          if #results >= maxResults then break end
        end
      end
    end
  end
end

return {
  query = query,
  mode = mode,
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
