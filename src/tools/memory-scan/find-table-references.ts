import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "find-table-references",
  title: "Find all GC references to a specific table (reverse ownership scan)",
  description:
    "Answer 'who holds this table alive / who can reach it?' Resolve a Luau expression to a target TABLE, then " +
    "walk the entire GC and record every OTHER object that references it: (1) for each GC TABLE, pcall-iterate " +
    "pairs() and if any VALUE is the target, record { container, via='value', key } (the surrounding key text); " +
    "(2) for each Lua CLOSURE, scan its upvalues (getupvalues, guarded) and if any UPVALUE is the target, record " +
    "{ container, via='upvalue', key } where container is the function's source:line (via debug.info / getinfo). " +
    "The target table itself is skipped so it never lists itself. This is the inverse of the look-down tools " +
    "(read-path-value, dump-table): use it to find the owner of a shared state/config table, to discover which " +
    "closures captured it (so you can hook or inspect them), or to understand why a table is not being collected. " +
    "Every access is pcall-guarded so locked objects never abort the scan; GC objects examined are capped by " +
    "maxScan and results by limit, with a 'truncated' flag. Requires getgc; upvalue scanning additionally needs " +
    "getupvalues (type-guarded — skipped if absent). Returns { target, referenceCount, scannedObjects, " +
    "truncated, references } or { error }.",
  category: "Memory Scan",
  input: z.object({
    tableExpr: z
      .string()
      .describe(
        "Luau expression resolving to the target TABLE whose references you want to find, e.g. " +
          "'getgenv().PlayerData', 'require(game.ReplicatedStorage.Config)', '_G.Settings', or any table " +
          "reference from a prior scan. Evaluated as `return <tableExpr>` and must resolve to a table.",
      ),
    limit: z
      .number()
      .int()
      .describe(
        "Maximum number of references to return (default 100). Hitting this sets truncated=true.",
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
  async execute({ tableExpr, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 5000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 200000);

    const source = `
${REFLECT_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local target, err = __eval(${q(tableExpr)})
if err then return { error = err } end
if type(target) ~= "table" then
  return { error = "tableExpr did not resolve to a table (got " .. typeof(target) .. "): " .. ${q(tableExpr)} }
end

local canUps = (type(__getupvalues) == "function")

local function fnLabel(fn)
  local info = __fnInfo(fn)
  local src = (info and info.ShortSource ~= "" and info.ShortSource) or (info and info.Source) or "?"
  local line = (info and info.LineDefined) or -1
  return tostring(src) .. ":" .. tostring(line)
end

local function safeKey(k)
  local ok, s = pcall(tostring, k)
  if not ok then return "<unprintable>" end
  if #s > 120 then s = string.sub(s, 1, 120) .. "..." end
  return s
end

local okGc, gc = pcall(getgc, true)
if not okGc or type(gc) ~= "table" then
  okGc, gc = pcall(getgc)
  if not okGc or type(gc) ~= "table" then return { error = "getgc returned no table." } end
end

local references = {}
local referenceCount = 0
local truncated = false
local scanned = 0

local function addRef(entry)
  referenceCount = referenceCount + 1
  if #references < ${lim} then
    references[#references + 1] = entry
  else
    truncated = true
  end
end

for _, obj in gc do
  scanned = scanned + 1
  if scanned > ${cap} then truncated = true break end

  local ot = type(obj)
  if ot == "table" then
    if obj ~= target then
      pcall(function()
        local label = nil
        for k, v in pairs(obj) do
          local ok, isHit = pcall(function() return v == target end)
          if ok and isHit then
            if not label then label = tostring(obj) end
            addRef({ container = label, via = "value", key = safeKey(k) })
          end
          if #references >= ${lim} then break end
        end
      end)
    end
  elseif ot == "function" and canUps then
    local oku, ups = pcall(__getupvalues, obj)
    if oku and type(ups) == "table" then
      local label = nil
      for idx, u in pairs(ups) do
        local ok, isHit = pcall(function() return u == target end)
        if ok and isHit then
          if not label then label = fnLabel(obj) end
          addRef({ container = label, via = "upvalue", key = "upvalue#" .. tostring(idx) })
        end
        if #references >= ${lim} then break end
      end
    end
  end

  if #references >= ${lim} then truncated = true break end
end

return {
  target = tostring(target),
  referenceCount = referenceCount,
  scannedObjects = scanned,
  truncated = truncated,
  references = references,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
