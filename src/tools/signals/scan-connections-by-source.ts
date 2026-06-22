import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

/** Sensible default set of commonly-connected signals to probe when the caller doesn't specify any. */
const DEFAULT_SIGNAL_NAMES = [
  "Touched",
  "TouchEnded",
  "Changed",
  "ChildAdded",
  "ChildRemoved",
  "DescendantAdded",
  "AncestryChanged",
  "Activated",
  "MouseButton1Click",
  "MouseButton1Down",
  "MouseButton1Up",
  "InputBegan",
  "InputChanged",
  "InputEnded",
  "OnClientEvent",
  "OnServerEvent",
  "Event",
  "Heartbeat",
  "RenderStepped",
  "Stepped",
];

export default defineTool({
  name: "scan-connections-by-source",
  title: "Scan connection handlers by defining script source",
  description:
    "Sweep a hierarchy for event handlers and pinpoint which script each handler is defined in. Walks " +
    "descendants of `root`, probes a set of signal names on each instance, and for every Lua connection " +
    "describes its Function via debug.info. If the function's Source contains `sourcePattern` " +
    "(case-insensitive substring; empty matches ALL handlers) it records " +
    '{ Instance, Signal, ConnectionIndex, Source, LineDefined, Name }. This answers "find every event ' +
    'handler defined in <script>", "where are all the handlers backed by this module?", or simply ' +
    '"enumerate all connected handlers under here and tell me their source". Requires the executor\'s ' +
    "getconnections and debug.info; degrades to a clear { error } if getconnections is unavailable (a " +
    "missing debug.info merely leaves Source blank). Bounded by maxScan (instances) and maxResults " +
    "(matches). Returns { Matches, MatchCount, ScannedInstances, Truncated }.",
  category: "Signals & Connections",
  input: z.object({
    root: z
      .string()
      .describe(
        "Lua expression for the root instance whose descendants are scanned (e.g. 'game', " +
          "'game.Workspace', 'game.StarterGui'). Evaluated as `return <root>`. Defaults to 'game'. " +
          "Narrow this to speed up the scan and reduce noise.",
      )
      .optional()
      .default("game"),
    sourcePattern: z
      .string()
      .describe(
        "Case-insensitive substring matched against each Lua connection's function Source (the chunk/script " +
          "path reported by debug.info, e.g. a script name or asset path). When empty (default), EVERY Lua " +
          "handler is matched, giving a full inventory. Set it to a script name to find only handlers defined " +
          "in that script.",
      )
      .optional()
      .default(""),
    signalNames: z
      .array(z.string())
      .describe(
        "Signal member names to probe on each instance. When omitted, a sensible default list of commonly " +
          "connected signals is used (Touched, Changed, ChildAdded, Activated, InputBegan, OnClientEvent, " +
          "Heartbeat, etc.). Provide your own list to target specific events and make the scan faster.",
      )
      .optional()
      .default(DEFAULT_SIGNAL_NAMES),
    maxResults: z
      .number()
      .int()
      .positive()
      .describe(
        "Maximum number of matching connections to collect before stopping the scan. Defaults to 200. " +
          "If this cap is hit, Truncated is true.",
      )
      .optional()
      .default(200),
    maxScan: z
      .number()
      .int()
      .positive()
      .describe(
        "Maximum number of descendant instances to examine. Defaults to 4000. Raise to cover larger games " +
          "(slower); lower for a quick sample. If this cap is hit, Truncated is true.",
      )
      .optional()
      .default(4000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ root, sourcePattern, signalNames, maxResults, maxScan, threadContext }, ctx) {
    const names = signalNames && signalNames.length > 0 ? signalNames : DEFAULT_SIGNAL_NAMES;
    const signalNamesLuau = "{ " + names.map((n) => q(n)).join(", ") + " }";

    const source = `
${SIGNAL_PRELUDE}
local rootInst, rerr = __resolveInstance(${q(root)})
if not rootInst then return { error = rerr } end
if type(__getconnectionsFn) ~= "function" then return { error = "getconnections is not available in this executor." } end

local signalNames = ${signalNamesLuau}
local pattern = ${q(sourcePattern)}
local patternLower = string.lower(pattern)
local hasPattern = pattern ~= ""
local maxResults = ${Math.trunc(maxResults)}
local maxScan = ${Math.trunc(maxScan)}

local scanned = 0
local truncated = false
local matches = {}

local okDesc, descendants = pcall(function() return rootInst:GetDescendants() end)
if not okDesc or type(descendants) ~= "table" then
  return { error = "Failed to enumerate descendants of " .. rootInst:GetFullName() .. "." }
end

local function matchesPattern(src)
  if not hasPattern then return true end
  if type(src) ~= "string" then return false end
  return string.find(string.lower(src), patternLower, 1, true) ~= nil
end

for i = 1, #descendants do
  if scanned >= maxScan then truncated = true break end
  if #matches >= maxResults then truncated = true break end
  local inst = descendants[i]
  scanned = scanned + 1
  local instPath = nil
  for s = 1, #signalNames do
    if #matches >= maxResults then truncated = true break end
    local sname = signalNames[s]
    local okSig, sig = pcall(function() return inst[sname] end)
    if okSig and typeof(sig) == "RBXScriptSignal" then
      local okC, conns = pcall(__getconnectionsFn, sig)
      if okC and type(conns) == "table" then
        for ci = 1, #conns do
          if #matches >= maxResults then truncated = true break end
          local okFn, fn = pcall(function() return conns[ci].Function end)
          if okFn and type(fn) == "function" then
            local desc = __describeFunction(fn)
            local src = desc and desc.Source or ""
            if matchesPattern(src) then
              if instPath == nil then
                local okP, p = pcall(function() return inst:GetFullName() end)
                instPath = okP and p or "?"
              end
              matches[#matches + 1] = {
                Instance = instPath,
                Signal = sname,
                ConnectionIndex = ci - 1,
                Source = src,
                LineDefined = desc and desc.LineDefined or -1,
                Name = desc and desc.Name or "<anonymous>",
              }
            end
          end
        end
      end
    end
  end
end

return {
  Matches = matches,
  MatchCount = #matches,
  ScannedInstances = scanned,
  Truncated = truncated,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
