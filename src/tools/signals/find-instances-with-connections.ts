import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "find-instances-with-connections",
  title: "Find instances that have connections on a named signal",
  description:
    "Walk every descendant of a root instance and report which ones have an active handler on a specific " +
    "signal. For each descendant it reads inst[signalName]; if that member is an RBXScriptSignal with at " +
    "least one connection (per getconnections), it records { Path, ClassName, ConnectionCount }. Results are " +
    'sorted by ConnectionCount descending. This answers questions like "which Parts in Workspace have a ' +
    'Touched handler?", "which GuiButtons are wired to Activated?", or "who is listening to Changed ' +
    "under this model?\". Requires the executor's getconnections; degrades to a clear { error } if " +
    "unavailable. Scanning is capped at `limit` instances to stay responsive on huge games. Returns " +
    "{ Signal, Root, ScannedInstances, Truncated, MatchCount, Instances: [...] }.",
  category: "Signals & Connections",
  input: z.object({
    root: z
      .string()
      .describe(
        "Lua expression for the root instance whose descendants are scanned (e.g. 'game', " +
          "'game.Workspace', 'game.Workspace.Map'). Evaluated as `return <root>`. Defaults to 'game' " +
          "(scans the whole DataModel up to the limit). Narrow this for faster, more focused scans.",
      )
      .optional()
      .default("game"),
    signalName: z
      .string()
      .describe(
        "REQUIRED name of the signal member to probe on each descendant (e.g. 'Touched', 'Changed', " +
          "'ChildAdded', 'Activated', 'OnClientEvent'). Only instances exposing this member as an " +
          "RBXScriptSignal with >0 connections are reported.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .describe(
        "Maximum number of descendant instances to SCAN (not match) before stopping. Defaults to 1000. " +
          "Increase to cover larger hierarchies (slower); decrease for a quick sample. If the scan stops " +
          "early because this cap was hit, Truncated is true.",
      )
      .optional()
      .default(1000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ root, signalName, limit, threadContext }, ctx) {
    const source = `
${SIGNAL_PRELUDE}
local rootInst, rerr = __resolveInstance(${q(root)})
if not rootInst then return { error = rerr } end
if type(__getconnectionsFn) ~= "function" then return { error = "getconnections is not available in this executor." } end

local signalName = ${q(signalName)}
local limit = ${Math.trunc(limit)}
local scanned = 0
local truncated = false
local matches = {}

local okDesc, descendants = pcall(function() return rootInst:GetDescendants() end)
if not okDesc or type(descendants) ~= "table" then
  return { error = "Failed to enumerate descendants of " .. rootInst:GetFullName() .. "." }
end

for i = 1, #descendants do
  if scanned >= limit then truncated = true break end
  local inst = descendants[i]
  scanned = scanned + 1
  local okSig, sig = pcall(function() return inst[signalName] end)
  if okSig and typeof(sig) == "RBXScriptSignal" then
    local okC, conns = pcall(__getconnectionsFn, sig)
    if okC and type(conns) == "table" and #conns > 0 then
      local path, cls = "?", "?"
      local okP, p = pcall(function() return inst:GetFullName() end); if okP then path = p end
      local okCl, c = pcall(function() return inst.ClassName end); if okCl then cls = c end
      matches[#matches + 1] = { Path = path, ClassName = cls, ConnectionCount = #conns }
    end
  end
end

table.sort(matches, function(a, b) return a.ConnectionCount > b.ConnectionCount end)

return {
  Signal = signalName,
  Root = rootInst:GetFullName(),
  ScannedInstances = scanned,
  Truncated = truncated,
  MatchCount = #matches,
  Instances = matches,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
