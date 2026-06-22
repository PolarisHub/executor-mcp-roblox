import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "scan-number-range",
  title: "Scan GC tables for numeric values in a [min, max] range (CE range scan)",
  description:
    "Cheat-Engine-style RANGE scan: walk every live Luau GC table and report each numeric value v where " +
    "min <= v <= max. Use this when you know a stat is within a window but not its exact value — e.g. coins " +
    "between 100 and 200, health under 50, a timer in [0, 10], a damage multiplier in [1, 5]. It is the inexact " +
    "complement to search-gc-value (which needs the precise number). Each hit is recorded as " +
    "{ table, key, value } where 'table' is the container address (tostring), 'key' is the field the number sits " +
    "under (tostring), and 'value' is the raw number. To narrow many hits down to one, run successive scans with " +
    "tightening bounds after the stat changes in-game (the Cheat-Engine 'next scan' technique), then read or flip " +
    "the survivor with read-path-value / write-path-value. Each table's pairs() iteration is pcall-guarded so a " +
    "locked/proxy table never aborts the scan; GC objects examined are capped by maxScan and results by limit, " +
    "with a 'truncated' flag. NaN values are skipped. Requires getgc (falls back from getgc(true) to getgc()). " +
    "Returns { min, max, matchCount, scannedObjects, truncated, matches } or { error }.",
  category: "Memory Scan",
  input: z.object({
    min: z
      .number()
      .describe(
        "Inclusive lower bound of the numeric window to match (e.g. 100 to find a coin total at least 100). " +
          "Values v with v >= min and v <= max are recorded.",
      ),
    max: z
      .number()
      .describe(
        "Inclusive upper bound of the numeric window to match (e.g. 200). Must be >= min for any hits. Combine " +
          "with min to bracket a stat you don't know exactly (e.g. min=100, max=200).",
      ),
    limit: z
      .number()
      .int()
      .describe(
        "Maximum number of matching numbers to return (default 150). Hitting this sets truncated=true.",
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
  async execute({ min, max, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 5000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 200000);
    const lo = Number.isFinite(min) ? min : -Infinity;
    const hi = Number.isFinite(max) ? max : Infinity;
    const loExpr = Number.isFinite(lo) ? String(lo) : "-math.huge";
    const hiExpr = Number.isFinite(hi) ? String(hi) : "math.huge";

    const source = `
${REFLECT_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local lo = ${loExpr}
local hi = ${hiExpr}

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
        -- guard against NaN (v == v is false for NaN) and bound-check
        if type(v) == "number" and v == v and v >= lo and v <= hi then
          if not label then label = tostring(obj) end
          matchCount = matchCount + 1
          if #matches < ${lim} then
            matches[#matches + 1] = { table = label, key = tostring(k), value = v }
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
  min = lo,
  max = hi,
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
