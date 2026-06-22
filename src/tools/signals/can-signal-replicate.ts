import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "can-signal-replicate",
  title: "Check whether a signal can be replicated to the server",
  description:
    "Query whether an RBXScriptSignal is one the Roblox engine permits to be replicated to the server, using the " +
    "executor's cansignalreplicate. When CanReplicate is true, the replicate-signal tool can fire this signal so " +
    "the server receives it as if the game client raised it natively — the basis for driving server-side logic " +
    "that is normally gated behind engine-internal signals. When false, replicate-signal will be rejected and you " +
    "must use a different vector. Use this to pre-flight a signal before attempting replication. Pass the instance " +
    "that owns the signal plus the signal member name (or leave signalName empty if instancePath already resolves " +
    "to the signal). Requires the cansignalreplicate executor function (Volt and similar full-API executors); " +
    "degrades with a clear { error } if unavailable. Returns { Signal, Instance?, CanReplicate, Note }.",
  category: "Signals & Connections",
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Lua expression resolving to the Instance that owns the signal (e.g. 'game.ReplicatedStorage.MyRemote', 'game.Workspace.Door'). Evaluated as `return <instancePath>`. Leave signalName empty if this expression already resolves to the RBXScriptSignal itself.",
      ),
    signalName: z
      .string()
      .describe(
        "Name of the RBXScriptSignal member on the instance (e.g. 'OnClientEvent', 'Touched', 'Changed'). Leave empty/omit if instancePath already evaluates to the signal.",
      )
      .optional()
      .default(""),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, signalName, threadContext }, ctx) {
    const source = `
${SIGNAL_PRELUDE}
local sig, inst, err = __resolveSignal(${q(instancePath)}, ${q(signalName)})
if not sig then return { error = err } end

if type(cansignalreplicate) ~= "function" then
  return { error = "cansignalreplicate is not available in this executor." }
end

local ok, res = pcall(cansignalreplicate, sig)
if not ok then return { error = "cansignalreplicate failed: " .. tostring(res) } end

local canRep = res and true or false

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  CanReplicate = canRep,
  Note = canRep
    and "The engine allows this signal to be replicated; replicate-signal can fire it to the server."
    or "The engine does NOT allow this signal to be replicated; replicate-signal will reject it.",
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
