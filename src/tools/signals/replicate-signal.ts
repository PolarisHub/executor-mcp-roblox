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
    "Ordered list of arguments to replicate with the event, mirroring the real arguments the server expects for this signal. Omit or pass [] to replicate with no arguments.",
  )
  .optional();

export default defineTool({
  name: "replicate-signal",
  title: "Replicate a signal to the SERVER",
  description:
    "MUTATES SERVER STATE — DANGEROUS. Invokes replicatesignal(signal, ...) to fire the event with full " +
    "network REPLICATION, so the event is delivered to the SERVER and can have real, authoritative server-side " +
    "effects (unlike fire-signal, which is local only). Only some signals are replicable; this tool first checks " +
    "cansignalreplicate(signal) and refuses to fire if it returns false. Use this ONLY for authorized testing of " +
    "a game you own/control — firing replicated signals on other games may violate their rules. Requires the " +
    "executor's replicatesignal; degrades with a clear { error } if unavailable. Returns " +
    "{ Signal, Instance?, Replicated, ArgCount } or { error }.",
  category: "Signals & Connections",
  mutatesState: true,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Lua expression resolving to the Instance that owns the signal (e.g. 'game.ReplicatedStorage.RemoteEvent'). Evaluated as `return <instancePath>`. Leave signalName empty if this expression already resolves to the signal itself.",
      ),
    signalName: z
      .string()
      .describe(
        "Name of the RBXScriptSignal member on the instance (e.g. 'OnClientEvent'). Leave empty/omit if instancePath already evaluates to the signal.",
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

if type(replicatesignal) ~= "function" then return { error = "replicatesignal is not available in this executor." } end

if type(cansignalreplicate) == "function" then
  local okCan, can = pcall(cansignalreplicate, sig)
  if not okCan then return { error = "cansignalreplicate failed: " .. tostring(can) } end
  if can == false then return { error = "Signal cannot be replicated (cansignalreplicate=false)." } end
end

${preamble}
local okRep, repErr = pcall(function() replicatesignal(sig${argExpr ? ", " + argExpr : ""}) end)
if not okRep then return { error = "replicatesignal failed: " .. tostring(repErr) } end

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  Replicated = true,
  ArgCount = ${argCount},
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
