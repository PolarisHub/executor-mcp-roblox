import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "script-grep",
  title: "Grep across all scripts in the game",
  description:
    "Search decompiled Roblox scripts for a pattern, line by line, with surrounding context. Enumerates every client-readable " +
    "LuaSourceContainer reachable from the active client (via QueryDescendants plus nil-parented scripts), decompiles each, and " +
    "reports matching lines grouped per script. Matching uses Luau string.find: with literal=true the query is matched as a plain " +
    "substring; otherwise it is treated as a Luau string pattern (note: Luau patterns, not JavaScript regex). Use exact identifiers " +
    "or simple patterns; use semantic-search-scripts when behavior is known but names are not. Decompilation is best-effort and can " +
    "be slow on large places, so the scan is capped by maxScripts.",
  category: "Inspection",
  input: z.object({
    query: z
      .string()
      .describe(
        "The search pattern. With literal=false it is interpreted as a Luau string pattern (%d, %w, %s, character classes [a-z], anchors, etc.). Use the literal flag for exact substring matching.",
      ),
    root: z
      .string()
      .describe(
        "Root instance to enumerate scripts under (e.g. 'game', 'game.ReplicatedStorage'). Defaults to 'game'. Narrow this to keep the scan fast.",
      )
      .optional()
      .default("game"),
    limit: z
      .number()
      .int()
      .describe("Maximum number of scripts to return results from (default: 50).")
      .optional()
      .default(50),
    contextLines: z
      .number()
      .int()
      .describe("Number of lines of context to show before and after each match (default: 2).")
      .optional()
      .default(2),
    maxMatchesPerScript: z
      .number()
      .int()
      .describe("Maximum number of matches to return per script (default: 20).")
      .optional()
      .default(20),
    maxScripts: z
      .number()
      .int()
      .describe("Maximum number of scripts to decompile and scan before stopping (default: 400).")
      .optional()
      .default(400),
    literal: z
      .boolean()
      .describe(
        "When true, treats the query as a plain literal substring - no pattern interpretation (string.find with plain=true). (default: false)",
      )
      .optional()
      .default(false),
    caseSensitive: z
      .boolean()
      .describe("When false, matches case-insensitively. (default: true)")
      .optional()
      .default(true),
    threadContext: z.number().int().optional(),
  }),
  async execute(
    {
      query,
      root,
      limit,
      contextLines,
      maxMatchesPerScript,
      maxScripts,
      literal,
      caseSensitive,
      threadContext,
    },
    ctx,
  ) {
    const scriptLimit = Math.max(1, Math.floor(limit));
    const ctxLines = Math.max(0, Math.floor(contextLines));
    const perScript = Math.max(1, Math.floor(maxMatchesPerScript));
    const scanCap = Math.max(1, Math.min(5000, Math.floor(maxScripts)));

    const source = `
if type(decompile) ~= "function" then
  return { error = "decompile is not available in this executor." }
end

local query = ${q(query)}
local scriptLimit = ${scriptLimit}
local ctxLines = ${ctxLines}
local perScript = ${perScript}
local scanCap = ${scanCap}
local literal = ${literal ? "true" : "false"}
local caseSensitive = ${caseSensitive ? "true" : "false"}

local needle = caseSensitive and query or string.lower(query)

local rootFn, rootErr = loadstring("return " .. ${q(root)})
if not rootFn then
  return { error = "Invalid root expression '" .. ${q(root)} .. "': " .. tostring(rootErr) }
end
local okRoot, rootInstance = pcall(rootFn)
if not okRoot or typeof(rootInstance) ~= "Instance" then
  return { error = "Root path did not resolve to an Instance: " .. ${q(root)} }
end

-- Collect candidate scripts: descendants of root + nil-parented LuaSourceContainers.
local candidates = {}
local seen = {}
local function add(inst)
  if not inst:IsA("LuaSourceContainer") then return end
  if inst:IsA("Script") and inst.RunContext == Enum.RunContext.Server then return end
  if seen[inst] then return end
  seen[inst] = true
  candidates[#candidates + 1] = inst
end

local okQuery, found = pcall(function() return rootInstance:QueryDescendants("LuaSourceContainer") end)
if okQuery and type(found) == "table" then
  for _, inst in ipairs(found) do add(inst) end
end
if type(getnilinstances) == "function" then
  local okNil, nils = pcall(getnilinstances)
  if okNil and type(nils) == "table" then
    for _, inst in ipairs(nils) do
      if typeof(inst) == "Instance" then add(inst) end
    end
  end
end

local function lineMatches(line)
  local hay = caseSensitive and line or string.lower(line)
  return string.find(hay, needle, 1, literal) ~= nil
end

local results = {}
local totalMatches = 0
local scanned = 0
local truncatedScan = false

for _, inst in ipairs(candidates) do
  if #results >= scriptLimit then break end
  if scanned >= scanCap then truncatedScan = true; break end
  scanned = scanned + 1

  local okSrc, src = pcall(function() return decompile(inst) end)
  if okSrc and type(src) == "string" then
    local lines = {}
    for line in (src .. "\\n"):gmatch("(.-)\\n") do lines[#lines + 1] = line end

    local blocks = {}
    for i = 1, #lines do
      if #blocks >= perScript then break end
      if lineMatches(lines[i]) then
        local startI = math.max(1, i - ctxLines)
        local endI = math.min(#lines, i + ctxLines)
        local block = {}
        for j = startI, endI do
          local marker = (j == i) and ">" or " "
          block[#block + 1] = marker .. " " .. j .. ": " .. lines[j]
        end
        blocks[#blocks + 1] = table.concat(block, "\\n")
      end
    end

    if #blocks > 0 then
      totalMatches = totalMatches + #blocks
      local okFull, full = pcall(function() return inst:GetFullName() end)
      results[#results + 1] = {
        Path = okFull and full or tostring(inst),
        ClassName = inst.ClassName,
        MatchCount = #blocks,
        Blocks = blocks,
      }
    end
  end
end

return {
  Query = query,
  TotalMatches = totalMatches,
  ScriptsMatched = #results,
  ScriptsScanned = scanned,
  TruncatedScan = truncatedScan,
  Results = results,
}
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 120000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
