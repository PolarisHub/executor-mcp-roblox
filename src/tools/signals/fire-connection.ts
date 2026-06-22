import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE, buildArgList } from "../_shared/signals.js";

const argsSchema = z
  .array(
    z.object({
      kind: z
        .enum(["string", "number", "boolean", "nil", "instance", "raw"])
        .describe(
          "How to interpret `value`: 'string'/'number'/'boolean' = a literal of that type; 'nil' = a Lua nil (value ignored); 'instance' = `value` is a Lua path like 'game.Players.LocalPlayer' resolved to an Instance at runtime; 'raw' = `value` is a raw Luau expression like 'Vector3.new(1,2,3)' evaluated at runtime.",
        ),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .describe(
          "The argument payload. Omit for kind='nil'. For kind='instance' pass a Lua path string; for kind='raw' pass a Luau expression string.",
        )
        .optional(),
    }),
  )
  .describe(
    "Ordered list of arguments to pass to the targeted connection's handler. Omit or pass [] to fire with no arguments.",
  )
  .optional();

export default defineTool({
  name: "fire-connection",
  title: "Fire one specific connection on a signal",
  description:
    "MUTATES CLIENT STATE. Invokes a single connection's :Fire(...) (or :Defer(...) when defer=true) so that " +
    "ONLY the one targeted handler runs with the supplied arguments — unlike fire-signal, which triggers every " +
    "connection. Identify the connection by its index within getconnections(signal) (use list-signal-connections " +
    "to find indices). This is client-side only and does not reach the server. Useful for isolating and testing a " +
    "single suspected handler. The connection's Fire/Defer methods may be absent on foreign/C connections, so the " +
    "call is pcall-guarded. Requires getconnections; degrades with a clear { error } if unavailable. Returns " +
    "{ Signal, Instance?, ConnectionIndex, Fired, Deferred } or { error }.",
  category: "Signals & Connections",
  mutatesState: true,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Lua expression resolving to the Instance that owns the signal (e.g. 'game.Workspace.Door'). Evaluated as `return <instancePath>`. Leave signalName empty if this expression already resolves to the signal itself.",
      ),
    signalName: z
      .string()
      .describe(
        "Name of the RBXScriptSignal member on the instance (e.g. 'Touched', 'Changed'). Leave empty/omit if instancePath already evaluates to the signal.",
      )
      .optional()
      .default(""),
    connectionIndex: z
      .number()
      .int()
      .min(0)
      .describe(
        "Zero-based index of the target connection within getconnections(signal), matching the Index reported by list-signal-connections. Defaults to 0 (the first connection).",
      )
      .optional()
      .default(0),
    defer: z
      .boolean()
      .describe(
        "When true, call connection:Defer(...) to schedule the handler on the next resumption cycle instead of running it synchronously. When false (default), call connection:Fire(...) to run it immediately.",
      )
      .optional()
      .default(false),
    args: argsSchema,
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, signalName, connectionIndex, defer, args, threadContext }, ctx) {
    const { preamble, argExpr } = buildArgList(args);
    const method = defer ? "Defer" : "Fire";
    const source = `
${SIGNAL_PRELUDE}
local sig, inst, err = __resolveSignal(${q(instancePath)}, ${q(signalName)})
if not sig then return { error = err } end

local conns, cerr = __getConns(sig)
if not conns then return { error = cerr } end

local idx = ${connectionIndex}
if idx < 0 or idx >= #conns then
  return { error = "connectionIndex " .. idx .. " out of range (signal has " .. #conns .. " connection(s); valid 0.." .. (#conns - 1) .. ")." }
end
local conn = conns[idx + 1]
if conn == nil then return { error = "No connection at index " .. idx .. "." } end

${preamble}
local okFire, fireErr = pcall(function() conn:${method}(${argExpr}) end)
if not okFire then return { error = "connection:${method} failed: " .. tostring(fireErr) } end

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  ConnectionIndex = idx,
  Fired = true,
  Deferred = ${defer ? "true" : "false"},
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
