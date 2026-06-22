import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "list-gc-functions",
  title: "List GC functions",
  description:
    "Enumerate live Lua closures from getgc() and return debug metadata (name/source/line/upvalues). Useful for live reversing when script paths are unknown.",
  category: "Reverse Engineering",
  input: z.object({
    nameQuery: z
      .string()
      .describe("Optional case-insensitive substring match against function names.")
      .optional(),
    sourceQuery: z
      .string()
      .describe("Optional case-insensitive substring match against debug source/short_src.")
      .optional(),
    includeCClosures: z
      .boolean()
      .describe("Include C closures from getgc (default: false).")
      .optional()
      .default(false),
    limit: z
      .number()
      .describe("Maximum number of functions to return (default: 100).")
      .optional()
      .default(100),
    threadContext: z.number().int().optional(),
  }),
  async execute({ nameQuery, sourceQuery, includeCClosures, limit, threadContext }, ctx) {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 1000);
    const source = `
local function contains(haystack, needle)
  if needle == "" then return true end
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

local nameNeedle = ${q(nameQuery ?? "")}
local sourceNeedle = ${q(sourceQuery ?? "")}
local includeC = ${includeCClosures ? "true" : "false"}
local maxResults = ${safeLimit}

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
        if contains(fnName, nameNeedle) and (contains(src, sourceNeedle) or contains(shortSrc, sourceNeedle)) then
          local upCount = 0
          if type(debug.getupvalues) == "function" then
            local okUps, ups = pcall(debug.getupvalues, obj)
            if okUps and type(ups) == "table" then
              upCount = #ups
            end
          elseif type(debug.getupvalue) == "function" then
            local i = 1
            while true do
              local okUp, upName = pcall(debug.getupvalue, obj, i)
              if not okUp or upName == nil then break end
              upCount = upCount + 1
              i = i + 1
              if i > 2000 then break end
            end
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
            FunctionPointer = tostring(obj),
          })
          if #results >= maxResults then break end
        end
      end
    end
  end
end

return {
  scanned = scanned,
  returned = #results,
  limit = maxResults,
  filters = { nameQuery = nameNeedle, sourceQuery = sourceNeedle, includeCClosures = includeC },
  results = results,
}
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
