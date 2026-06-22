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
    "Ordered list of arguments to pass to the connection handlers, mirroring the real arguments the event would normally fire with. Omit or pass [] to fire with no arguments.",
  )
  .optional();

export default defineTool({
  name: "fire-signal",
  title: "Fire all local connections of a signal",
  description:
    "MUTATES CLIENT STATE. Invokes firesignal(signal, ...) to synchronously fire EVERY local Lua connection " +
    "currently attached to an RBXScriptSignal, passing the supplied arguments. This is client-side only: it runs " +
    "the handlers in your own client and does NOT send anything to the server or other players. Useful for " +
    "exercising a game's own event handlers (e.g. simulating a 'Touched' or a custom BindableEvent) while " +
    "debugging UI/gameplay logic, without performing the real physical action. NOTE: firesignal invokes the " +
    "connection functions directly and does NOT respect a connection's Disabled state — disabled connections still " +
    "run. (A real event, or set-connection-state, does respect Enabled/Disabled.) Requires the executor's firesignal; " +
    "degrades with a clear { error } if unavailable. Returns { Signal, Instance?, Fired, ArgCount } or { error }.",
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
        "Name of the RBXScriptSignal member on the instance (e.g. 'Touched', 'Changed', 'OnClientEvent'). Leave empty/omit if instancePath already evaluates to the signal.",
      )
      .optional()
      .default(""),
    args: argsSchema,
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, signalName, args, threadContext }, ctx) {
    const { preamble, argExpr } = buildArgList(args);
    const argCount = args?.length ?? 0;
    const source = `
${SIGNAL_PRELUDE}
local sig, inst, err = __resolveSignal(${q(instancePath)}, ${q(signalName)})
if not sig then return { error = err } end

if type(firesignal) ~= "function" then return { error = "firesignal is not available in this executor." } end

${preamble}
local okFire, fireErr = pcall(function() firesignal(sig${argExpr ? ", " + argExpr : ""}) end)
if not okFire then return { error = "firesignal failed: " .. tostring(fireErr) } end

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  Fired = true,
  ArgCount = ${argCount},
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
