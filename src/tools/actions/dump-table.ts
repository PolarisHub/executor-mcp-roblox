import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "dump-table",
  title: "Recursively dump a Luau table",
  description:
    "Resolve a Luau expression to a TABLE and recursively encode its contents to a chosen depth. Scalar, Instance " +
    "and function values are encoded via the shared encoder; nested tables are recursed into until maxDepth, after " +
    "which they collapse to 'table: <addr> (truncated)'. Each level is capped at maxKeys (the cap is noted via a " +
    "per-level Truncated flag), and cycles are detected so self-referential tables won't loop forever. Ideal for " +
    "reading config tables, getgenv()/getrenv() subtables, a ModuleScript's return value, or any captured upvalue " +
    "table you already have a handle on. " +
    "WARNING: this ACTS ON THE LIVE GAME — it evaluates your expression in the running client, which may trigger " +
    "__index metamethods or other side effects while iterating. " +
    "Returns { Target, Depth, Table:<nested>, Truncated } or { error }.",
  category: "Actions",
  input: z.object({
    tablePath: z
      .string()
      .describe(
        "Luau expression resolving to a table, e.g. 'getgenv()', 'getrenv()._G', 'require(game.ReplicatedStorage.Config)', " +
          "'getrawmetatable(game)', or 'debug.getupvalues(someFn)[1]'. Evaluated as `return <tablePath>` and must yield a table.",
      ),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe(
        "How many levels of nested tables to recurse into (default 2, max 5). Beyond this depth, nested tables are " +
          "rendered as 'table: <addr> (truncated)' rather than expanded.",
      )
      .optional()
      .default(2),
    maxKeys: z
      .number()
      .int()
      .min(1)
      .max(500)
      .describe(
        "Maximum number of keys to encode PER table level (default 100, max 500). When a level has more keys than " +
          "this, the extras are dropped and that level is flagged Truncated = true.",
      )
      .optional()
      .default(100),
    threadContext: z.number().int().optional(),
  }),
  async execute({ tablePath, maxDepth, maxKeys, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
local __maxDepth = ${maxDepth}
local __maxKeys = ${maxKeys}
local __truncatedAny = false

local function __dump(tbl, depth, seen)
  if type(tbl) ~= "table" then return __encVal(tbl) end
  if seen[tbl] then return "table: " .. tostring(tbl) .. " (cycle)" end
  if depth > __maxDepth then
    __truncatedAny = true
    return "table: " .. tostring(tbl) .. " (truncated)"
  end
  seen[tbl] = true
  local out = {}
  local count = 0
  local levelTruncated = false
  local okIter = pcall(function()
    for k, v in pairs(tbl) do
      count = count + 1
      if count > __maxKeys then
        levelTruncated = true
        __truncatedAny = true
        break
      end
      local key = tostring(k)
      if type(v) == "table" then
        out[key] = __dump(v, depth + 1, seen)
      else
        out[key] = __encVal(v)
      end
    end
  end)
  if not okIter then out.__iterError = "failed to iterate table" end
  if levelTruncated then out.__truncated = true end
  seen[tbl] = nil
  return out
end

local target, err = __eval(${q(tablePath)})
if err then return { error = err } end
if type(target) ~= "table" then
  return { error = "expression did not resolve to a table (got " .. typeof(target) .. "): " .. ${q(tablePath)} }
end

local okDump, dumped = pcall(__dump, target, 1, {})
if not okDump then return { error = "failed to dump table: " .. tostring(dumped) } end

return {
  Target = ${q(tablePath)},
  Depth = __maxDepth,
  Table = dumped,
  Truncated = __truncatedAny,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
