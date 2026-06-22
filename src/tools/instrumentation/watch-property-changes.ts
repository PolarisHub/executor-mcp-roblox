import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "watch-property-changes",
  title: "Record EVERY property that changes on an Instance over a window (event-driven)",
  description:
    "Connects an Instance's Changed signal for a bounded window and records EVERY property that changes (its name plus " +
    "the new value), then disconnects and returns the log. This is the discovery counterpart to watch-instance-property " +
    "(inspection), which polls a SINGLE named property you already know: use watch-property-changes when you DON'T know " +
    "which property to watch and want to see everything that moves — e.g. perform an action in-game and learn which of an " +
    "Instance's properties the game actually mutates, or catch a property you didn't expect to change. " +
    "It uses a signal CONNECTION (Instance.Changed), not a function hook, so it is low-risk; the connection is always " +
    "disconnected at the end of the window.\n\n" +
    "HOW IT WORKS: resolves the Instance, connects inst.Changed (which fires with the changed property NAME for plain " +
    "Instances), and for each fire pcall-reads inst[prop] and appends { property, newValue, t }; then task.wait(s) for " +
    "the duration and disconnects. The call BLOCKS for roughly durationMs while listening — perform the triggering " +
    "action (click/move/etc.) shortly before or during the watch. NOTE: on some objects the Changed signal carries a " +
    "Property-value-changed payload rather than a name (e.g. ValueBase objects fire with the value); this tool records " +
    "the raw signal argument as the property identifier in that case. " +
    "Returns { Path, ClassName, durationMs, changeCount, changes = [{ property, newValue, t }], truncated } or { error }.",
  category: "Instrumentation",
  mutatesState: false,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau expression resolving to the Instance to watch, e.g. " +
          "'game.Players.LocalPlayer.Character.Humanoid', 'game.Workspace.Part', or " +
          "'game.Players.LocalPlayer.PlayerGui.HUD.Frame'. Evaluated as `return <instancePath>` and must resolve to an " +
          "Instance.",
      ),
    durationMs: z
      .number()
      .int()
      .describe(
        "How long to listen, in milliseconds (default 4000, min 100, max 30000). The tool BLOCKS for about this long; " +
          "trigger the change you want to observe shortly before or during this window.",
      )
      .optional()
      .default(4000),
    limit: z
      .number()
      .int()
      .describe(
        "Maximum number of change records to keep (default 500, max 2000). When more changes fire than this cap, the " +
          "extra ones are dropped and `truncated` is set true.",
      )
      .optional()
      .default(500),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, durationMs, limit, threadContext }, ctx) {
    const duration = Math.max(100, Math.min(30000, Math.floor(durationMs ?? 4000)));
    const cap = Math.max(1, Math.min(2000, Math.floor(limit ?? 500)));

    const source = `
${REFLECT_PRELUDE}
local inst, err = __eval(${q(instancePath)})
if err then return { error = err } end
if typeof(inst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(inst) .. "): " .. ${q(instancePath)} } end

local CAP = ${cap}
local durationSec = ${duration} / 1000

local path = ${q(instancePath)}
local okName, full = pcall(function() return inst:GetFullName() end)
if okName then path = full end
local className = nil
pcall(function() className = inst.ClassName end)

local changes = {}
local changeCount = 0
local truncated = false
local startClock = (type(os) == "table" and os.clock and os.clock()) or 0

local okConn, conn = pcall(function()
  return inst.Changed:Connect(function(prop)
    changeCount = changeCount + 1
    if #changes >= CAP then truncated = true; return end
    pcall(function()
      -- For plain Instances 'prop' is the property NAME; read its new value.
      local propName = tostring(prop)
      local newEnc = nil
      if type(prop) == "string" then
        local okRead, val = pcall(function() return inst[prop] end)
        if okRead then newEnc = __encVal(val) else newEnc = "<read-failed>" end
      else
        -- Non-string payload (e.g. ValueBase fires with the value itself).
        newEnc = __encVal(prop)
      end
      table.insert(changes, {
        property = propName,
        newValue = newEnc,
        t = (type(os) == "table" and os.clock and (os.clock() - startClock)) or 0,
      })
    end)
  end)
end)

if not okConn or typeof(conn) ~= "RBXScriptConnection" then
  return { error = "Failed to connect Changed signal: " .. tostring(conn) }
end

-- Block for the watch window, then always disconnect.
task.wait(durationSec)
pcall(function() conn:Disconnect() end)

return {
  Path = path,
  ClassName = className,
  durationMs = ${duration},
  changeCount = changeCount,
  returned = #changes,
  truncated = truncated,
  changes = changes,
}
`;

    // Give the connector round-trip a buffer beyond the in-game wait so the
    // tool does not time out before the Luau window finishes.
    const timeoutMs = duration + 15000;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
