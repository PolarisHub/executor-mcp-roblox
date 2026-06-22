import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "find-tables-by-key",
  title: "Find GC tables that contain a named string key (structure scan)",
  description:
    "Cheat-Engine-style STRUCTURE scan: walk every live Luau GC table and report each one that contains a string " +
    "key matching `key`. This is the complement to search-gc-value (which matches by stored VALUE) — here you " +
    "match by the NAME of a field, which is ideal when you know a stat/config table exposes a field like 'Coins', " +
    "'WalkSpeed', 'GodMode' or 'Config' but you don't yet know the value or the container. For every matching key " +
    "the tool records { table, matchedKey, sampleValue } where 'table' is the table's address (tostring), " +
    "'matchedKey' is the exact key string found, and 'sampleValue' is the encoded current value at that key — so " +
    "you can immediately see what the field holds. Set contains=true for a substring match on key names " +
    "(string.find with plain=true). Iteration of each table is pcall-guarded so locked/proxy tables never abort " +
    "the scan; the number of GC objects examined is capped by maxScan and the result list by limit, with a " +
    "'truncated' flag when either cap is hit. Pivot from a hit with read-path-value / write-path-value (using a " +
    "Luau expression that reaches the container) to read or flip the field. Requires getgc (falls back from " +
    "getgc(true) to getgc()). Returns { matchCount, scannedObjects, truncated, matches } or { error }.",
  category: "Memory Scan",
  input: z.object({
    key: z
      .string()
      .describe(
        "The field name to look for as a KEY in GC tables, e.g. 'Coins', 'Health', 'WalkSpeed', 'GodMode', " +
          "'Config'. With contains=false (default) only string keys exactly equal to this are matched; with " +
          "contains=true any string key whose text includes this substring matches (case-sensitive, plain text).",
      ),
    contains: z
      .boolean()
      .describe(
        "When true, match any string key that CONTAINS `key` as a plain substring (string.find with plain=true) " +
          "instead of requiring exact equality. Default false (exact match). Use for fuzzy field discovery.",
      )
      .optional()
      .default(false),
    limit: z
      .number()
      .int()
      .describe(
        "Maximum number of matched keys to return (default 100). Hitting this sets truncated=true.",
      )
      .optional()
      .default(100),
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
  async execute({ key, contains, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 5000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 200000);
    const useContains = contains === true;

    const source = `
${REFLECT_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local needle = ${q(key)}
local useContains = ${useContains ? "true" : "false"}

local function keyHit(k)
  if type(k) ~= "string" then return false end
  if useContains then
    local ok, found = pcall(string.find, k, needle, 1, true)
    return ok and found ~= nil
  end
  return k == needle
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
        if keyHit(k) then
          if not label then label = tostring(obj) end
          matchCount = matchCount + 1
          if #matches < ${lim} then
            local okEnc, enc = pcall(__encVal, v)
            matches[#matches + 1] = { table = label, matchedKey = k, sampleValue = okEnc and enc or "<unprintable>" }
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
