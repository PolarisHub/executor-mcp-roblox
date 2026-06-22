import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "get-function-upvalues",
  title: "Get function upvalues",
  description:
    "Find matching functions in getgc() and dump their upvalues for live reverse engineering.",
  category: "Reverse Engineering",
  input: z.object({
    query: z.string().describe("Case-insensitive match against function name/source."),
    sourceQuery: z.string().describe("Optional additional source filter.").optional(),
    maxFunctions: z
      .number()
      .describe("Maximum number of matched functions to inspect (default: 5).")
      .optional()
      .default(5),
    maxUpvalues: z
      .number()
      .describe("Maximum upvalues per function (default: 30).")
      .optional()
      .default(30),
    includeCClosures: z
      .boolean()
      .describe("Include C closures (default: false).")
      .optional()
      .default(false),
    threadContext: z.number().int().optional(),
  }),
  async execute(
    { query, sourceQuery, maxFunctions, maxUpvalues, includeCClosures, threadContext },
    ctx,
  ) {
    const safeMaxFunctions = Math.min(Math.max(Math.floor(maxFunctions), 1), 50);
    const safeMaxUpvalues = Math.min(Math.max(Math.floor(maxUpvalues), 1), 200);
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

local query = ${q(query)}
local sourceNeedle = ${q(sourceQuery ?? "")}
local maxFunctions = ${safeMaxFunctions}
local maxUpvalues = ${safeMaxUpvalues}
local includeC = ${includeCClosures ? "true" : "false"}

local inspected = {}
for _, obj in ipairs(getgcFn(true)) do
  if type(obj) == "function" then
    local okInfo, info = pcall(debug.getinfo, obj, "nSlu")
    if okInfo and info then
      if includeC or info.what ~= "C" then
        local fnName = info.name or "<anonymous>"
        local src = info.source or ""
        local shortSrc = info.short_src or ""
        if contains(fnName, query) or contains(src, query) or contains(shortSrc, query) then
          if contains(src, sourceNeedle) or contains(shortSrc, sourceNeedle) then
            local entry = {
              Name = fnName,
              Source = src,
              ShortSource = shortSrc,
              LineDefined = info.linedefined or -1,
              FunctionPointer = tostring(obj),
              Upvalues = {},
            }

            local loaded = false
            if type(debug.getupvalue) == "function" then
              loaded = true
              for i = 1, maxUpvalues do
                local okUp, upName, upValue = pcall(debug.getupvalue, obj, i)
                if not okUp or upName == nil then break end
                entry.Upvalues[#entry.Upvalues + 1] = {
                  Index = i,
                  Name = tostring(upName),
                  Type = typeof and typeof(upValue) or type(upValue),
                  Preview = tostring(upValue),
                }
              end
            elseif type(debug.getupvalues) == "function" then
              loaded = true
              local okUps, ups = pcall(debug.getupvalues, obj)
              if okUps and type(ups) == "table" then
                for i, upValue in ipairs(ups) do
                  if i > maxUpvalues then break end
                  entry.Upvalues[#entry.Upvalues + 1] = {
                    Index = i,
                    Name = "<unknown>",
                    Type = typeof and typeof(upValue) or type(upValue),
                    Preview = tostring(upValue),
                  }
                end
              end
            end

            if not loaded then
              entry.Upvalues = { { Index = 0, Name = "<unsupported>", Type = "none", Preview = "debug upvalue APIs unavailable" } }
            end

            table.insert(inspected, entry)
            if #inspected >= maxFunctions then break end
          end
        end
      end
    end
  end
end

return {
  query = query,
  sourceQuery = sourceNeedle,
  matchedFunctions = #inspected,
  results = inspected,
}
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
