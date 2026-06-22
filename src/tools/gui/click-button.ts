import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

const CLICK_SIGNALS = [
  "Activated",
  "MouseButton1Down",
  "MouseButton2Down",
  "MouseButton1Click",
  "MouseButton2Click",
] as const;

export default defineTool({
  name: "click-button",
  title: "Click a GuiButton",
  description:
    "WRITES LIVE GAME STATE. Click a Roblox TextButton or ImageButton by firing its GUI signals via firesignal, " +
    "exactly as if the local player clicked it — so any handler connected to the button runs. Use when direct UI " +
    "activation is needed inside the active client. Resolves the path to a GuiButton, then either fires the single " +
    "named action signal or, when action is omitted, fires every standard click signal (Activated, MouseButton1Down, " +
    "MouseButton2Down, MouseButton1Click, MouseButton2Click). Requires the executor's firesignal; degrades with a " +
    "clear { error } if unavailable. Returns { Path, Fired, ok } or { error }.",
  category: "GUI",
  mutatesState: true,
  input: z.object({
    path: z.string().describe("The instance path to the Button"),
    action: z
      .string()
      .describe(
        "The specific signal to fire (e.g., 'Activated', 'MouseButton1Click'). If omitted, fires all standard click signals.",
      )
      .optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ path, action, threadContext }, ctx) {
    const actionExpr = action ? q(action) : "nil";
    const signalsExpr = `{ ${CLICK_SIGNALS.map((s) => q(s)).join(", ")} }`;
    const source = `
if type(firesignal) ~= "function" then return { error = "Your executor does not support 'firesignal', which is required for this command." } end

local okEval, button = pcall(function() return (loadstring("return " .. ${q(path)}))() end)
if not okEval then return { error = "failed to evaluate path: " .. tostring(button) } end

if typeof(button) ~= "Instance" then return { error = "Path did not resolve to a valid Instance." } end
local okIs, isButton = pcall(function() return button:IsA("GuiButton") end)
if not okIs or not isButton then return { error = "Resolved Instance is not a GuiButton (e.g., TextButton or ImageButton)." } end

local signals = ${signalsExpr}
local action = ${actionExpr}
local fired = {}

if action ~= nil then
  if not table.find(signals, action) then
    return { error = "Invalid action provided. Valid actions are: " .. table.concat(signals, ", ") }
  end
  local okFire, fireErr = pcall(function() firesignal(button[action]) end)
  if not okFire then return { error = "firesignal failed for '" .. action .. "': " .. tostring(fireErr) } end
  fired[#fired + 1] = action
else
  for _, signalName in ipairs(signals) do
    local ok = pcall(function() firesignal(button[signalName]) end)
    if ok then fired[#fired + 1] = signalName end
  end
end

local okPath, full = pcall(function() return button:GetFullName() end)

return { Path = okPath and full or ${q(path)}, Fired = fired, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
