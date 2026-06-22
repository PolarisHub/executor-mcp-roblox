import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "press-key",
  title: "Simulate a keyboard key press",
  description:
    "WRITES LIVE GAME STATE. Simulate a real keyboard key press/release in the running client via " +
    "VirtualInputManager, so anything listening for keyboard input runs: UserInputService.InputBegan/InputEnded, " +
    "ContextActionService bindings, default movement, and keybound abilities. The key string is resolved against " +
    "Enum.KeyCode (e.g. 'E', 'Space', 'W', 'LeftShift', 'F'); an unknown name returns a clean error listing what " +
    "you passed. Sends KeyDown immediately, optionally holds for holdSec seconds (via task.wait) to emulate a held " +
    "key, then sends KeyUp. NOTE: VirtualInputManager:SendKeyEvent only works from an exploit/elevated context " +
    "(injected executor thread) — in an ordinary game script it is locked and will error. Getting the service and " +
    "each SendKeyEvent are pcall-guarded. WARNING: this drives real input into the game and may move the character " +
    "or trigger abilities. Returns { key, ok, error? }.",
  category: "GUI",
  mutatesState: true,
  input: z.object({
    key: z
      .string()
      .describe(
        "The Enum.KeyCode name to press, e.g. 'E', 'Space', 'W', 'A', 'S', 'D', 'LeftShift', 'F', 'Return', 'One'. " +
          "Case-sensitive and must match an Enum.KeyCode member exactly. Resolved as Enum.KeyCode[key].",
      ),
    holdSec: z
      .number()
      .describe(
        "How long (seconds) to hold the key down before releasing it. Default 0 = a quick tap (KeyDown then " +
          "immediate KeyUp). Use a small positive value (e.g. 0.5) to emulate a held key for charge/hold mechanics. " +
          "Capped at 10 seconds to avoid blocking the executor thread.",
      )
      .optional()
      .default(0),
    threadContext: z.number().int().optional(),
  }),
  async execute({ key, holdSec, threadContext }, ctx) {
    const hold = Math.min(Math.max(Number.isFinite(holdSec) ? holdSec : 0, 0), 10);
    const source = `
${REFLECT_PRELUDE}
local keyName = ${q(key)}

local okKc, kc = pcall(function() return Enum.KeyCode[keyName] end)
if not okKc or typeof(kc) ~= "EnumItem" then
  return { key = keyName, ok = false, error = "unknown KeyCode '" .. keyName .. "' (must be an exact Enum.KeyCode member name, e.g. 'E', 'Space', 'LeftShift')." }
end

local okSvc, vim = pcall(function() return game:GetService("VirtualInputManager") end)
if not okSvc or typeof(vim) ~= "Instance" then
  return { key = keyName, ok = false, error = "could not get VirtualInputManager: " .. tostring(vim) }
end

local okDown, downErr = pcall(function() vim:SendKeyEvent(true, kc, false, game) end)
if not okDown then
  return { key = keyName, ok = false, error = "SendKeyEvent (down) failed (VirtualInputManager requires an exploit/elevated context): " .. tostring(downErr) }
end

if ${hold} > 0 and type(task) == "table" and type(task.wait) == "function" then
  pcall(task.wait, ${hold})
end

local okUp, upErr = pcall(function() vim:SendKeyEvent(false, kc, false, game) end)
if not okUp then
  return { key = keyName, ok = false, error = "SendKeyEvent (up) failed; key may be stuck down: " .. tostring(upErr) }
end

return { key = keyName, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
