import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "set-connection-state",
  title: "Disable / enable / disconnect signal connections",
  description:
    "MUTATES CLIENT STATE. Toggles or removes connections on an RBXScriptSignal: 'disable' temporarily stops a " +
    "connection from firing (reversible with 'enable'), 'enable' re-activates a disabled connection, and " +
    "'disconnect' permanently removes it — IRREVERSIBLE for that connection (you would have to recreate it). " +
    "scope='one' targets a single connection by index; scope='all' applies to every connection on the signal. " +
    "Because they are destructive, scope='all' and action='disconnect' BOTH require confirm=true or the tool " +
    "refuses without changing anything. Useful for silencing or surgically removing event handlers (e.g. " +
    "anti-cheat or input listeners) while debugging. Requires getconnections plus the connection's " +
    "Disable/Enable/Disconnect methods; degrades with a clear { error } if unavailable. Returns " +
    "{ Signal, Instance?, Action, Scope, Affected } or { error }.",
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
    action: z
      .enum(["disable", "enable", "disconnect"])
      .describe(
        "What to do to the matched connection(s): 'disable' = stop firing but keep it (reversible via 'enable'); 'enable' = re-activate a disabled connection; 'disconnect' = permanently remove it (IRREVERSIBLE, requires confirm=true).",
      ),
    scope: z
      .enum(["one", "all"])
      .describe(
        "'one' (default) affects only the single connection at connectionIndex; 'all' affects every connection on the signal and REQUIRES confirm=true.",
      )
      .optional()
      .default("one"),
    connectionIndex: z
      .number()
      .int()
      .min(0)
      .describe(
        "Zero-based index of the target connection within getconnections(signal) when scope='one', matching the Index from list-signal-connections. Ignored when scope='all'. Defaults to 0.",
      )
      .optional()
      .default(0),
    confirm: z
      .boolean()
      .describe(
        "Safety gate for destructive operations. Must be true to run when scope='all' OR action='disconnect'; otherwise the tool refuses without making changes. Not required for disable/enable on a single connection.",
      )
      .optional()
      .default(false),
    threadContext: z.number().int().optional(),
  }),
  async execute(
    { instancePath, signalName, action, scope, connectionIndex, confirm, threadContext },
    ctx,
  ) {
    const requiresConfirm = scope === "all" || action === "disconnect";
    if (requiresConfirm && confirm !== true) {
      return {
        data: { error: `Refusing to ${action} ${scope}; pass confirm=true.` },
        summary: `Refusing to ${action} ${scope}; pass confirm=true.`,
        isError: true,
      };
    }

    const method =
      action === "disconnect" ? "Disconnect" : action === "enable" ? "Enable" : "Disable";

    const source = `
${SIGNAL_PRELUDE}
local sig, inst, err = __resolveSignal(${q(instancePath)}, ${q(signalName)})
if not sig then return { error = err } end

local conns, cerr = __getConns(sig)
if not conns then return { error = cerr } end

local scope = ${q(scope)}
local affected = 0

local function apply(conn)
  if conn == nil then return false end
  local ok = pcall(function() conn:${method}() end)
  return ok
end

if scope == "all" then
  for i = 1, #conns do
    if apply(conns[i]) then affected = affected + 1 end
  end
else
  local idx = ${connectionIndex}
  if idx < 0 or idx >= #conns then
    return { error = "connectionIndex " .. idx .. " out of range (signal has " .. #conns .. " connection(s); valid 0.." .. (#conns - 1) .. ")." }
  end
  if apply(conns[idx + 1]) then affected = affected + 1 end
end

return {
  Signal = ${signalName ? q(signalName) : "tostring(sig)"},
  Instance = inst and inst:GetFullName() or nil,
  Action = ${q(action)},
  Scope = scope,
  Affected = affected,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
