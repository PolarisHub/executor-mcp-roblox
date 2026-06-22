import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "get-signal-arguments",
  title: "Get the argument types a signal fires with",
  description:
    "Report the value TYPES that an RBXScriptSignal fires its connected handlers with, using the executor's " +
    'getsignalarguments. This answers "what shape is the payload of this event?" without having to connect a ' +
    "handler and wait for a fire — invaluable when reverse-engineering a remote-driven or engine signal so you " +
    "know how to construct a fire-signal / replicate-signal call. Pass the instance that owns the signal plus the " +
    "signal member name (or leave signalName empty if instancePath already resolves to the signal). Requires the " +
    "getsignalarguments executor function (Volt and similar full-API executors); degrades with a clear { error } " +
    "if unavailable. Returns { Signal, Instance?, Arguments } where Arguments is the type/scalar info mapped " +
    "through a safe serializer.",
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

if type(getsignalarguments) ~= "function" then
  return { error = "getsignalarguments is not available in this executor." }
end

local ok, res = pcall(getsignalarguments, sig)
if not ok then return { error = "getsignalarguments failed: " .. tostring(res) } end

local function __mapArgs(v)
  if type(v) == "table" then
    local out = {}
    for k, val in pairs(v) do
      if type(val) == "table" then
        local inner = {}
        for ik, iv in pairs(val) do inner[ik] = __encVal(iv) end
        out[k] = inner
      else
        out[k] = __encVal(val)
      end
    end
    return out
  end
  return __encVal(v)
end

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  Arguments = __mapArgs(res),
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
