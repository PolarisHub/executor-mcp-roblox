import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "get-connection-upvalues",
  title: "Dump the upvalues of a connection's handler function",
  description:
    "Read the captured upvalues of the Lua function bound to ONE connection on an RBXScriptSignal (selected by " +
    "zero-based index) via debug.getupvalues. Upvalues are the variables a closure captured from its enclosing " +
    "scope — typically shared state, config tables, cached services or other functions — so this reveals the live " +
    "context a hidden event handler operates on. Each upvalue is reported with its typeof and a readable encoded " +
    "value (instances become full names, tables/functions become descriptors). Requires getconnections and " +
    "debug.getupvalues (Volt-class executor); returns a clear { error } if either is missing or the connection has " +
    "no Lua Function. Returns { Signal, Instance?, ConnectionIndex, Function, Upvalues: [...], Count }.",
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
        "Zero-based index of the connection whose handler upvalues to read, as reported by list-signal-connections. 0 is the first connection. Must be < ConnectionCount or a clear { error } is returned.",
      )
      .optional()
      .default(0),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, signalName, connectionIndex, threadContext }, ctx) {
    const source = `
${SIGNAL_PRELUDE}
local __getupvaluesFn = (type(debug) == "table") and debug.getupvalues or nil
if type(__getupvaluesFn) ~= "function" then return { error = "debug.getupvalues is not available in this executor." } end

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

local okU, ups = pcall(__getupvaluesFn, fn)
if not okU then return { error = "debug.getupvalues failed: " .. tostring(ups) } end
if type(ups) ~= "table" then return { error = "debug.getupvalues returned a non-table value." } end

local out = {}
for i = 1, #ups do
  out[i] = { Index = i - 1, Type = typeof(ups[i]), Value = __encVal(ups[i]) }
end

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  ConnectionIndex = idx,
  Function = __describeFunction(fn),
  Upvalues = out,
  Count = #out,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
