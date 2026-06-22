import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "get-signal-arguments-info",
  title: "Get detailed per-argument info for a signal",
  description:
    "Report RICH, per-argument metadata about what an RBXScriptSignal fires with, using the executor's " +
    "getsignalargumentsinfo. This is the more detailed companion to get-signal-arguments: where that tool reports " +
    "just the argument types/values, this returns the executor's fuller per-argument descriptor table (e.g. type " +
    "tags, optionality, and per-entry detail) so you can precisely reconstruct a signal's payload when crafting a " +
    "fire-signal / replicate-signal call. Pass the instance that owns the signal plus the signal member name (or " +
    "leave signalName empty if instancePath already resolves to the signal). Requires the getsignalargumentsinfo " +
    "executor function (Volt and similar full-API executors); degrades with a clear { error } if unavailable. " +
    "Returns { Signal, Instance?, ArgumentsInfo } with nested values mapped through a safe serializer.",
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

if type(getsignalargumentsinfo) ~= "function" then
  return { error = "getsignalargumentsinfo is not available in this executor." }
end

local ok, res = pcall(getsignalargumentsinfo, sig)
if not ok then return { error = "getsignalargumentsinfo failed: " .. tostring(res) } end

-- Deeply map any nested tables through __encVal so the (potentially rich) info is serializable.
local function __mapDeep(v, depth)
  if type(v) ~= "table" or depth > 6 then return __encVal(v) end
  local out = {}
  for k, val in pairs(v) do
    if type(val) == "table" then
      out[k] = __mapDeep(val, depth + 1)
    else
      out[k] = __encVal(val)
    end
  end
  return out
end

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  ArgumentsInfo = __mapDeep(res, 0),
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
