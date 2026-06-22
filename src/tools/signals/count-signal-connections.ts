import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "count-signal-connections",
  title: "Count connections on a signal (breakdown)",
  description:
    "Resolve an RBXScriptSignal and return a fast numeric breakdown of everything connected to it: " +
    "Total connections, how many are Lua vs Foreign (engine/C-side), how many are currently Enabled vs " +
    "Disabled, and how many carry a Lua Function. Use this as a lightweight first pass before " +
    'list-signal-connections when you only need counts (e.g. "how many handlers are on this RemoteEvent?", ' +
    '"are any of this signal\'s connections disabled?"). Does NOT describe each function, so it is much ' +
    "cheaper than the full listing. Requires the executor's getconnections; degrades to a clear { error } " +
    "if unavailable. Returns { Signal, Instance?, Total, Lua, Foreign, Enabled, Disabled, WithFunction }.",
  category: "Signals & Connections",
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Lua expression resolving to the Instance that owns the signal (e.g. 'game.Workspace.Door', " +
          "'game.ReplicatedStorage.RemoteEvent'). Evaluated as `return <instancePath>`. Leave signalName " +
          "empty if this expression already resolves to the RBXScriptSignal itself.",
      ),
    signalName: z
      .string()
      .describe(
        "Name of the RBXScriptSignal member on the instance (e.g. 'Touched', 'Changed', 'OnClientEvent'). " +
          "Leave empty/omit if instancePath already evaluates to the signal.",
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

local conns, cerr = __getConns(sig)
if not conns then return { error = cerr } end

local total, lua, foreign, enabled, disabled, withFn = 0, 0, 0, 0, 0, 0
for i = 1, #conns do
  local info = __connInfo(conns[i], i - 1, false)
  total = total + 1
  if info.LuaConnection then lua = lua + 1 else foreign = foreign + 1 end
  if info.Enabled then enabled = enabled + 1 else disabled = disabled + 1 end
  if info.HasFunction then withFn = withFn + 1 end
end

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  Total = total,
  Lua = lua,
  Foreign = foreign,
  Enabled = enabled,
  Disabled = disabled,
  WithFunction = withFn,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
