import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "find-string-in-tables",
  title: "Find string VALUES stored in GC tables (runtime string data scan)",
  description:
    "Walk every live Luau GC table and report each string VALUE that matches `query`. This is the runtime-DATA " +
    "complement to find-string-xrefs (which scans closures' bytecode constants): it finds strings that exist as " +
    "actual table data at this moment — server responses, built-up chat/UI text, dynamically constructed remote " +
    "names, cached config strings, decoded tokens — which may never appear as a source literal. By default " +
    "contains=true performs a plain (non-pattern) substring search; set contains=false for exact equality. Each " +
    "hit is recorded as { table, key, value } where 'table' is the container address (tostring), 'key' is the " +
    "field (tostring), and 'value' is the matched string truncated to its first 200 characters. Pivot from a hit " +
    "with read-path-value / write-path-value (or find-table-references to see who owns the container). Each " +
    "table's pairs() iteration is pcall-guarded so locked/proxy tables never abort the scan; GC objects examined " +
    "are capped by maxScan and results by limit, with a 'truncated' flag. Requires getgc (falls back from " +
    "getgc(true) to getgc()). Returns { query, contains, matchCount, scannedObjects, truncated, matches } or " +
    "{ error }.",
  category: "Memory Scan",
  input: z.object({
    query: z
      .string()
      .describe(
        "The string to search for among table VALUES, e.g. 'GodMode', 'http', 'BuyItem', a token prefix, or any " +
          "substring of runtime text. With contains=true (default) any string value containing this matches; " +
          "with contains=false only string values exactly equal to this match. Case-sensitive, plain text " +
          "(not a Lua pattern).",
      ),
    contains: z
      .boolean()
      .describe(
        "When true (default), match any string value that CONTAINS `query` as a plain substring (string.find " +
          "with plain=true). When false, require exact string equality. Use exact to pin one specific value.",
      )
      .optional()
      .default(true),
    limit: z
      .number()
      .int()
      .describe(
        "Maximum number of matching strings to return (default 150). Hitting this sets truncated=true.",
      )
      .optional()
      .default(150),
    maxScan: z
      .number()
      .int()
      .describe(
        "Maximum number of GC objects to examine before stopping (default 40000). Hitting this sets " +
          "truncated=true. Raise for a deeper sweep at the cost of time; lower if scans are slow.",
      )
      .optional()
      .default(40000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ query, contains, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 5000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 200000);
    const useContains = contains !== false;

    const source = `
${REFLECT_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local needle = ${q(query)}
local useContains = ${useContains ? "true" : "false"}

local function valHit(v)
  if type(v) ~= "string" then return false end
  if useContains then
    local ok, found = pcall(string.find, v, needle, 1, true)
    return ok and found ~= nil
  end
  return v == needle
end

local okGc, gc = pcall(getgc, true)
if not okGc or type(gc) ~= "table" then
  okGc, gc = pcall(getgc)
  if not okGc or type(gc) ~= "table" then return { error = "getgc returned no table." } end
end

local matches = {}
local matchCount = 0
local truncated = false
local scanned = 0

for _, obj in gc do
  scanned = scanned + 1
  if scanned > ${cap} then truncated = true break end

  if type(obj) == "table" then
    pcall(function()
      local label = nil
      for k, v in pairs(obj) do
        if valHit(v) then
          if not label then label = tostring(obj) end
          matchCount = matchCount + 1
          if #matches < ${lim} then
            local s = v
            if #s > 200 then s = string.sub(s, 1, 200) .. "..." end
            matches[#matches + 1] = { table = label, key = tostring(k), value = s }
          else
            truncated = true
          end
        end
        if #matches >= ${lim} then break end
      end
    end)
  end

  if #matches >= ${lim} then truncated = true break end
end

return {
  query = needle,
  contains = useContains,
  matchCount = matchCount,
  scannedObjects = scanned,
  truncated = truncated,
  matches = matches,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
