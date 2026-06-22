import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "search-gc-value",
  title: "Search the GC heap for where a value is stored (Cheat-Engine scan)",
  description:
    "Cheat-Engine-style heap scanner: find WHERE a specific value lives across the entire Luau garbage collector. " +
    "Resolve a target from one of five value types, then walk every live object via getgc(true) and report each " +
    "place that holds it. For GC TABLES the tool pcall-iterates pairs() and records a hit when a KEY or a VALUE " +
    "matches (string matches support exact OR 'contains' substring search). For Lua CLOSURES (when scanFunctions " +
    "is on) it scans the function's constants and upvalues. Each match reports { container, where, keyText? } where " +
    "'where' is one of value/key/constant/upvalue and 'container' is the table address or the closure's source:line. " +
    "Use it to locate a coin/HP total, a remote or flag name, a boolean toggle, or a Part/Instance reference, then " +
    "pivot with inspect-closure / dump-table / set-closure-upvalue to read or mutate it. " +
    "Requires getgc; closure scanning additionally requires getconstants/getupvalues (each is type-guarded and " +
    "simply skipped if the executor lacks it). Everything is pcall-guarded so locked/dead objects never abort the " +
    "scan; the object count is capped by maxScan and the result list by limit, with a 'truncated' flag. " +
    "Returns { valueType, matchCount, truncated, matches } or { error }.",
  category: "Memory Scan",
  input: z.object({
    valueType: z
      .enum(["number", "string", "boolean", "instance", "raw"])
      .describe(
        "How to interpret 'value' and what to search for:\n" +
          "- 'number': search for a numeric value (e.g. a coin/HP total).\n" +
          "- 'string': search for a string (supports match='contains' for substrings — e.g. a remote name).\n" +
          "- 'boolean': search for true/false (e.g. a god-mode flag).\n" +
          "- 'instance': 'value' is a Luau path/expression resolving to an Instance (e.g. 'game.Workspace.Boss').\n" +
          "- 'raw': 'value' is an arbitrary Luau expression; the tool searches for whatever it evaluates to " +
          "(e.g. 'Enum.KeyCode.E', 'Vector3.new(0,0,0)', 'game:GetService(\"Players\").LocalPlayer').",
      ),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .describe(
        "The value to search for. For number/string/boolean this is the literal value. For 'instance' it is a Luau " +
          "path expression resolving to an Instance. For 'raw' it is a Luau expression that is evaluated and whose " +
          "result is the search target. Required for instance/raw; for number/string/boolean it may be omitted only " +
          "if you really mean to search for the empty string / 0 / false (prefer always supplying it).",
      )
      .optional(),
    match: z
      .enum(["exact", "contains"])
      .describe(
        "Match mode (default 'exact'). 'contains' performs a plain (non-pattern) substring search and applies ONLY " +
          "to string searches; for every other value type it is ignored and exact equality is used.",
      )
      .optional()
      .default("exact"),
    scanFunctions: z
      .boolean()
      .describe(
        "Also scan Lua closures' constants and upvalues for the target (default true). Disable to scan tables only, " +
          "which is faster and avoids getconstants/getupvalues overhead.",
      )
      .optional()
      .default(true),
    limit: z
      .number()
      .int()
      .describe(
        "Max number of match locations to return (default 150). Hitting this sets truncated=true.",
      )
      .optional()
      .default(150),
    maxScan: z
      .number()
      .int()
      .describe(
        "Max number of GC objects (tables + functions) to examine before stopping (default 40000). Hitting this " +
          "sets truncated=true. Raise for a more thorough sweep at the cost of time; lower it if scans are slow.",
      )
      .optional()
      .default(40000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ valueType, value, match, scanFunctions, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 5000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 200000);
    const matchMode = match === "contains" ? "contains" : "exact";
    const scanFns = scanFunctions !== false;

    // Build the Luau expression that yields the search target.
    // number/string/boolean are embedded as literals; instance/raw are
    // evaluated through loadstring at runtime so paths/expressions resolve in
    // the game environment.
    let targetExpr: string;
    let needsLoad = false;
    if (valueType === "number") {
      const n = typeof value === "number" ? value : Number(value ?? 0);
      targetExpr = Number.isFinite(n) ? String(n) : "0/0"; // NaN -> 0/0 (will simply never match)
    } else if (valueType === "boolean") {
      const b = value === true || value === "true" || value === 1;
      targetExpr = b ? "true" : "false";
    } else if (valueType === "string") {
      targetExpr = q(String(value ?? ""));
    } else {
      // instance | raw -> evaluate the supplied Luau expression
      needsLoad = true;
      targetExpr = q(String(value ?? "nil"));
    }

    const source = `
local __getconstants = getconstants or (type(debug) == "table" and (debug.getconstants or debug.getconstant))
local __getupvalues = getupvalues or (type(debug) == "table" and (debug.getupvalues or debug.getupvalue))
local __getinfo = (type(getinfo) == "function" and getinfo) or (type(debug) == "table" and (debug.getinfo or debug.info))

if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

-- ----- resolve the search target -----------------------------------------
local target
${
  needsLoad
    ? `local loader = loadstring or load
if type(loader) ~= "function" then return { error = "loadstring/load is not available in this executor." } end
local okc, chunk = pcall(loader, "return " .. ${targetExpr})
if not okc or type(chunk) ~= "function" then
  return { error = "Failed to compile expression: " .. tostring(chunk) }
end
local okr, val = pcall(chunk)
if not okr then return { error = "Error evaluating expression: " .. tostring(val) } end
target = val
${
  valueType === "instance"
    ? `if typeof(target) ~= "Instance" then
  return { error = "Expression did not resolve to an Instance (got " .. typeof(target) .. ")." }
end`
    : ``
}`
    : `target = ${targetExpr}`
}

local matchMode = ${q(matchMode)}
local targetIsString = (type(target) == "string")
local useContains = (matchMode == "contains") and targetIsString

-- equality test (plain substring for string 'contains', else identity/==)
local function isHit(x)
  if useContains then
    if type(x) ~= "string" then return false end
    local ok, found = pcall(string.find, x, target, 1, true)
    return ok and found ~= nil
  end
  -- raw equality; pcall-guarded because comparing exotic userdata can error
  local ok, eq = pcall(function() return x == target end)
  return ok and eq == true
end

-- short, safe label for a function container: "source:line"
local function fnLabel(fn)
  local src, line = "?", -1
  if type(__getinfo) == "function" then
    local ok, info = pcall(__getinfo, fn, "sl")
    if ok and type(info) == "table" then
      src = info.short_src or info.source or src
      line = info.linedefined or info.currentline or line
    else
      local oks, s = pcall(__getinfo, fn, "s"); if oks and s ~= nil and type(s) ~= "table" then src = tostring(s) end
      local okl, l = pcall(__getinfo, fn, "l"); if okl and type(l) == "number" then line = l end
    end
  end
  return tostring(src) .. ":" .. tostring(line)
end

-- safe tostring for a key/container label, capped in length
local function safeText(v)
  local ok, s = pcall(function()
    local t = typeof(v)
    if t == "Instance" then
      local okn, n = pcall(function() return v:GetFullName() end)
      return okn and ("Instance: " .. n) or "<Instance>"
    end
    return tostring(v)
  end)
  if not ok then return "<unprintable>" end
  if #s > 200 then s = string.sub(s, 1, 200) .. "..." end
  return s
end

-- ----- walk the GC -------------------------------------------------------
local okGc, gc = pcall(getgc, true)
if not okGc or type(gc) ~= "table" then
  okGc, gc = pcall(getgc)
  if not okGc or type(gc) ~= "table" then
    return { error = "getgc returned no table." }
  end
end

local matches = {}
local matchCount = 0
local truncated = false
local scanned = 0
local scanFns = ${scanFns ? "true" : "false"}
local canConsts = scanFns and (type(__getconstants) == "function")
local canUps = scanFns and (type(__getupvalues) == "function")

local function addMatch(entry)
  matchCount = matchCount + 1
  if #matches < ${lim} then
    matches[#matches + 1] = entry
  else
    truncated = true
  end
end

for _, obj in gc do
  scanned = scanned + 1
  if scanned > ${cap} then
    truncated = true
    break
  end

  local ot = type(obj)
  if ot == "table" then
    -- iterate keys + values; pcall the whole loop so locked/proxy tables can't abort the scan
    pcall(function()
      local label = nil
      for k, v in pairs(obj) do
        if isHit(v) then
          if not label then label = tostring(obj) end
          addMatch({ container = label, where = "value", keyText = safeText(k) })
        end
        if isHit(k) then
          if not label then label = tostring(obj) end
          addMatch({ container = label, where = "key", keyText = safeText(k) })
        end
        if #matches >= ${lim} then break end
      end
    end)
  elseif ot == "function" and scanFns then
    if canConsts then
      local okc, consts = pcall(__getconstants, obj)
      if okc and type(consts) == "table" then
        local label = nil
        for _, c in pairs(consts) do
          if isHit(c) then
            if not label then label = fnLabel(obj) end
            addMatch({ container = label, where = "constant" })
          end
        end
      end
    end
    if canUps then
      local oku, ups = pcall(__getupvalues, obj)
      if oku and type(ups) == "table" then
        local label = nil
        for _, u in pairs(ups) do
          if isHit(u) then
            if not label then label = fnLabel(obj) end
            addMatch({ container = label, where = "upvalue" })
          end
        end
      end
    end
  end

  if #matches >= ${lim} then
    -- keep scanning only to count? No — stop early once output is full to stay fast.
    truncated = true
    break
  end
end

return {
  valueType = ${q(valueType)},
  matchMode = matchMode,
  scannedObjects = scanned,
  matchCount = matchCount,
  truncated = truncated,
  matches = matches,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
