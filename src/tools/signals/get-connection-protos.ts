import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "get-connection-protos",
  title: "List the nested child functions of a connection's handler",
  description:
    "Enumerate the inner (proto) functions defined inside the Lua function bound to ONE connection on an " +
    "RBXScriptSignal (selected by zero-based index) via debug.getprotos. Protos are the nested closures a handler " +
    "creates — callbacks, deferred tasks, helper lambdas — so this maps out the sub-functions you may want to hook " +
    "or inspect next. Each proto is reported via the standard function descriptor (Source, Name, LineDefined, " +
    "NumParams, IsVararg, What, Pointer). Requires getconnections and debug.getprotos (Volt-class executor); " +
    "returns a clear { error } if either is missing or the connection has no Lua Function. " +
    "Returns { Signal, Instance?, ConnectionIndex, Function, Protos: [...], Count }.",
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
        "Zero-based index of the connection whose handler protos to enumerate, as reported by list-signal-connections. 0 is the first connection. Must be < ConnectionCount or a clear { error } is returned.",
      )
      .optional()
      .default(0),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, signalName, connectionIndex, threadContext }, ctx) {
    const source = `
${SIGNAL_PRELUDE}
local __getprotosFn = (type(debug) == "table") and debug.getprotos or nil
if type(__getprotosFn) ~= "function" then return { error = "debug.getprotos is not available in this executor." } end

local sig, inst, err = __resolveSignal(${q(instancePath)}, ${q(signalName)})
if not sig then return { error = err } end

local conns, cerr = __getConns(sig)
if not conns then return { error = cerr } end

local idx = ${connectionIndex}
if idx < 0 or idx >= #conns then
  return { error = "connectionIndex " .. tostring(idx) .. " is out of range (signal has " .. tostring(#conns) .. " connection(s); valid 0.." .. tostring(#conns - 1) .. ")." }
end

local conn = conns[idx + 1]
local okFn, fn = pcall(function() return conn.Function end)
if not okFn or type(fn) ~= "function" then
  return { error = "Connection " .. tostring(idx) .. " has no Lua Function (it may be a C/foreign or thread connection)." }
end

local okP, protos = pcall(__getprotosFn, fn)
if not okP then return { error = "debug.getprotos failed: " .. tostring(protos) } end
if type(protos) ~= "table" then return { error = "debug.getprotos returned a non-table value." } end

local out = {}
for i = 1, #protos do
  local desc = __describeFunction(protos[i])
  if desc then desc.Index = i - 1 end
  out[i] = desc
end

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  ConnectionIndex = idx,
  Function = __describeFunction(fn),
  Protos = out,
  Count = #out,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
