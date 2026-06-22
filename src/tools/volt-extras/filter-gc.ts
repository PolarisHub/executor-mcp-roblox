import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Build a Luau literal for one scalar criterion value. Strings funnel through q();
 * finite numbers and booleans are emitted inline. Anything else becomes nil so a
 * malformed value can never break the chunk.
 */
function scalar(value: unknown): string {
  if (typeof value === "string") return q(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  return "nil";
}

/** Build a Lua array literal `{ a, b, c }` from a JS array of scalars. */
function arrayLiteral(values: unknown[]): string {
  return `{ ${values.map((v) => scalar(v)).join(", ")} }`;
}

/**
 * Build a Lua record literal `{ [k] = v, ... }` from a JS record of scalars.
 * Keys are emitted as bracketed string literals so reserved words / odd keys are safe.
 */
function recordLiteral(record: Record<string, unknown>): string {
  const parts = Object.entries(record).map(([k, v]) => `[${q(k)}] = ${scalar(v)}`);
  return `{ ${parts.join(", ")} }`;
}

const ScalarCriterion = z.union([z.string(), z.number(), z.boolean()]);

export default defineTool({
  name: "filter-gc",
  title: "filtergc — query the GC heap for functions or tables by structural criteria (Volt)",
  description:
    "The headline Volt reflection tool: run the executor's UNC filtergc(filterType, options) against the entire live " +
    "garbage collector to find Lua closures or tables that match a structural fingerprint, without writing any Luau by " +
    "hand. Far more targeted than a raw getgc() sweep — you describe WHAT you are looking for and the executor returns " +
    "only the objects that match. " +
    "For filterType='function' the options are { Name?, Hash?, IgnoreExecutor? (default true), Constants? (array of " +
    "constants the closure must reference), Upvalues? (array of upvalue values the closure must hold) } — e.g. find the " +
    "closure that owns the string 'FireServer' and the upvalue 1337. For filterType='table' the options are " +
    "{ Keys? (array of keys that must be present), Values? (array of values that must be present), KeyValuePairs? " +
    "(record of exact key=value pairs), Metatable? } — e.g. find the player-data table that has a 'Coins' key. " +
    "Each match is encoded to a compact summary: functions report { source, line, name } (via debug.info) and tables " +
    "report { address, keyCount }. Output is capped by 'limit'. " +
    "Requires a Volt-class executor exposing filtergc (type-guarded; returns { error } on a non-Volt executor) and " +
    "every call is pcall-wrapped so a locked object can never abort the query. Returns { filterType, matchCount, " +
    "truncated, matches } or { error }.",
  category: "Reverse Engineering",
  input: z.object({
    filterType: z
      .enum(["function", "table"])
      .describe(
        "What kind of GC object to search for: 'function' (Lua closures) or 'table'. This selects which option set " +
          "below is meaningful.",
      ),
    options: z
      .object({
        // function criteria
        Name: z
          .string()
          .optional()
          .describe("function only: the closure's name (debug.info name) must equal this."),
        Hash: z
          .string()
          .optional()
          .describe("function only: the closure's getfunctionhash() must equal this."),
        IgnoreExecutor: z
          .boolean()
          .optional()
          .describe(
            "function only: exclude closures that belong to the executor's own VM (default true). Set false to also " +
              "match executor-internal closures.",
          ),
        Constants: z
          .array(ScalarCriterion)
          .optional()
          .describe(
            "function only: an array of constants (strings/numbers/bools) the closure must reference in its constant " +
              "table — e.g. ['FireServer'].",
          ),
        Upvalues: z
          .array(ScalarCriterion)
          .optional()
          .describe(
            "function only: an array of upvalue values the closure must currently hold — e.g. [1337, true].",
          ),
        // table criteria
        Keys: z
          .array(ScalarCriterion)
          .optional()
          .describe(
            "table only: an array of keys that must all be present in the table — e.g. ['Coins','Level'].",
          ),
        Values: z
          .array(ScalarCriterion)
          .optional()
          .describe("table only: an array of values that must all be present in the table."),
        KeyValuePairs: z
          .record(z.string(), ScalarCriterion)
          .optional()
          .describe(
            "table only: a record of exact key=value pairs the table must contain — e.g. { GodMode = true }.",
          ),
        Metatable: ScalarCriterion.optional().describe(
          "table only: the table's metatable must equal this value (rarely used; usually supplied as a previously " +
            "found reference is not possible here, so prefer Keys/Values).",
        ),
      })
      .describe(
        "The UNC filtergc criteria. Only the fields relevant to filterType are emitted into the Luau.",
      ),
    limit: z
      .number()
      .int()
      .default(100)
      .describe(
        "Maximum number of matches to encode and return (default 100). Hitting this sets truncated=true.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ filterType, options, limit, threadContext, timeoutMs }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 2000);

    // Assemble the Luau options table from only the criteria that apply to the
    // selected filterType. Everything funnels through scalar()/arrayLiteral()/
    // recordLiteral() so user strings are always q()-quoted.
    const fields: string[] = [];
    if (filterType === "function") {
      if (options.Name !== undefined) fields.push(`Name = ${scalar(options.Name)}`);
      if (options.Hash !== undefined) fields.push(`Hash = ${scalar(options.Hash)}`);
      // IgnoreExecutor defaults to true when omitted.
      const ignore = options.IgnoreExecutor !== false;
      fields.push(`IgnoreExecutor = ${ignore ? "true" : "false"}`);
      if (options.Constants && options.Constants.length > 0)
        fields.push(`Constants = ${arrayLiteral(options.Constants)}`);
      if (options.Upvalues && options.Upvalues.length > 0)
        fields.push(`Upvalues = ${arrayLiteral(options.Upvalues)}`);
    } else {
      if (options.Keys && options.Keys.length > 0)
        fields.push(`Keys = ${arrayLiteral(options.Keys)}`);
      if (options.Values && options.Values.length > 0)
        fields.push(`Values = ${arrayLiteral(options.Values)}`);
      if (options.KeyValuePairs && Object.keys(options.KeyValuePairs).length > 0)
        fields.push(`KeyValuePairs = ${recordLiteral(options.KeyValuePairs)}`);
      if (options.Metatable !== undefined) fields.push(`Metatable = ${scalar(options.Metatable)}`);
    }
    const optsLiteral = `{ ${fields.join(", ")} }`;

    const source = `
if type(filtergc) ~= "function" then
  return { error = "filtergc is not available in this executor." }
end

local __getinfo = (type(debug) == "table" and (debug.info or debug.getinfo)) or nil

local opts = ${optsLiteral}

-- Run filtergc with returnOne=false so we get the full match list.
local ok, matches = pcall(filtergc, ${q(filterType)}, opts, false)
if not ok then
  return { error = "filtergc failed: " .. tostring(matches) }
end
if type(matches) ~= "table" then
  -- filtergc may return a single object when returnOne is honoured oddly; wrap it.
  if matches == nil then
    matches = {}
  else
    matches = { matches }
  end
end

local LIMIT = ${lim}
local out = {}
local total = 0
local truncated = false

local function fnSummary(fn)
  local src, line, name = "?", -1, nil
  if type(__getinfo) == "function" then
    local oks, s = pcall(__getinfo, fn, "s"); if oks and type(s) == "string" then src = s end
    local okl, l = pcall(__getinfo, fn, "l"); if okl and type(l) == "number" then line = l end
    local okn, n = pcall(__getinfo, fn, "n"); if okn and type(n) == "string" and n ~= "" then name = n end
  end
  return { kind = "function", source = src, line = line, name = name }
end

local function tableSummary(t)
  local addr = tostring(t)
  local keyCount = 0
  pcall(function()
    for _ in pairs(t) do keyCount = keyCount + 1 end
  end)
  return { kind = "table", address = addr, keyCount = keyCount }
end

for _, obj in matches do
  total = total + 1
  if #out < LIMIT then
    local ot = type(obj)
    if ot == "function" then
      out[#out + 1] = fnSummary(obj)
    elseif ot == "table" then
      out[#out + 1] = tableSummary(obj)
    else
      out[#out + 1] = { kind = ot, value = tostring(obj) }
    end
  else
    truncated = true
  end
end

return {
  filterType = ${q(filterType)},
  matchCount = total,
  truncated = truncated,
  matches = out,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 45000 });
    return { data };
  },
});
