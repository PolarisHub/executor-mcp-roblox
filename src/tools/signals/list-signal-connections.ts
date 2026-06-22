import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "list-signal-connections",
  title: "List all connections on a signal",
  description:
    "Enumerate every connection on an RBXScriptSignal and, for each, report its full Connection metadata: " +
    "Index, Enabled, LuaConnection, ForeignState, whether it has a Function/Thread, and (for Lua connections) the " +
    "connected function's Source script, Name, LineDefined and NumParams. This is the main tool for answering " +
    '"what is listening to this event and where is each handler defined?". Requires getconnections; degrades ' +
    "with a clear { error } if unavailable. Returns { Signal, Instance?, ConnectionCount, Connections: [...] }.",
  category: "Signals & Connections",
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Lua expression resolving to the Instance that owns the signal (e.g. 'game.Workspace.Door', 'game.Players.PlayerAdded' parent). Evaluated as `return <instancePath>`. Leave signalName empty if this expression already resolves to the signal itself.",
      ),
    signalName: z
      .string()
      .describe(
        "Name of the RBXScriptSignal member on the instance (e.g. 'Touched', 'Changed', 'OnClientEvent'). Leave empty/omit if instancePath already evaluates to the signal.",
      )
      .optional()
      .default(""),
    includeFunctionInfo: z
      .boolean()
      .describe(
        "When true (default), resolve each Lua connection's function source/line/name via debug.info. Set false for a faster summary that only reports counts and connection flags.",
      )
      .optional()
      .default(true),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, signalName, includeFunctionInfo, threadContext }, ctx) {
    const source = `
${SIGNAL_PRELUDE}
local sig, inst, err = __resolveSignal(${q(instancePath)}, ${q(signalName)})
if not sig then return { error = err } end

local conns, cerr = __getConns(sig)
if not conns then return { error = cerr } end

local withFn = ${includeFunctionInfo ? "true" : "false"}
local list = {}
local luaCount, foreignCount, enabledCount = 0, 0, 0
for i = 1, #conns do
  local info = __connInfo(conns[i], i - 1, withFn)
  if info.LuaConnection then luaCount = luaCount + 1 else foreignCount = foreignCount + 1 end
  if info.Enabled then enabledCount = enabledCount + 1 end
  list[#list + 1] = info
end

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  ConnectionCount = #conns,
  LuaConnections = luaCount,
  ForeignConnections = foreignCount,
  EnabledConnections = enabledCount,
  Connections = list,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
