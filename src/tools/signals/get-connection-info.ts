import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "get-connection-info",
  title: "Inspect a single signal connection in detail",
  description:
    "Return the full Connection metadata for ONE connection on an RBXScriptSignal, selected by zero-based index. " +
    "Reports Index, Enabled, LuaConnection, ForeignState, whether it has a Function/Thread, the connected thread's " +
    "status (when present), and — for Lua connections — the handler function's Source script, Name, LineDefined, " +
    "NumParams, IsVararg and What. Use this to zoom in on a specific listener after list-signal-connections shows " +
    "you the index of interest. Requires getconnections; degrades with a clear { error } if unavailable or if the " +
    "index is out of range. Returns { Signal, Instance?, ConnectionCount, Connection: {...} }.",
  category: "Signals & Connections",
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Lua expression resolving to the Instance that owns the signal (e.g. 'game.Workspace.Door'). Evaluated as `return <instancePath>`. Leave signalName empty if this expression already resolves to the RBXScriptSignal itself.",
      ),
    signalName: z
      .string()
      .describe(
        "Name of the RBXScriptSignal member on the instance (e.g. 'Touched', 'Changed', 'OnClientEvent'). Leave empty/omit if instancePath already evaluates to the signal.",
      )
      .optional()
      .default(""),
    connectionIndex: z
      .number()
      .int()
      .min(0)
      .describe(
        "Zero-based index of the connection to inspect, as reported by list-signal-connections. 0 is the first connection. Must be < ConnectionCount or a clear { error } is returned.",
      )
      .optional()
      .default(0),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, signalName, connectionIndex, threadContext }, ctx) {
    const source = `
${SIGNAL_PRELUDE}
local sig, inst, err = __resolveSignal(${q(instancePath)}, ${q(signalName)})
if not sig then return { error = err } end

local conns, cerr = __getConns(sig)
if not conns then return { error = cerr } end

local idx = ${connectionIndex}
if idx < 0 or idx >= #conns then
  return { error = "connectionIndex " .. tostring(idx) .. " is out of range (signal has " .. tostring(#conns) .. " connection(s); valid 0.." .. tostring(#conns - 1) .. ")." }
end

local conn = conns[idx + 1]
local info = __connInfo(conn, idx, true)

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  ConnectionCount = #conns,
  Connection = info,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
