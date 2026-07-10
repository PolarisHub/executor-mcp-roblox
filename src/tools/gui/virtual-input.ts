import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

const ACTIONS = [
  "keyDown",
  "keyUp",
  "keyPress",
  "mouseMove",
  "mouseButton",
  "mouseWheel",
  "touch",
  "gamepadButton",
  "gamepadAxis",
] as const;

export default defineTool({
  name: "virtual-input",
  title: "Send a low-level virtual input event",
  description:
    "WRITES LIVE GAME STATE. Send keyboard, mouse, touch, or gamepad input into the active Roblox client. " +
    "This is the broad low-level input surface: keyDown/keyUp/keyPress use Enum.KeyCode, mouseMove supports " +
    "absolute or relative movement, mouseButton supports down/up/click, mouseWheel sends a wheel delta, touch " +
    "sends Begin/Change/End, and gamepadButton/gamepadAxis target a gamepad. VirtualInputManager is preferred; " +
    "common executor mouse/key fallbacks are used when available. Calls into VirtualInputManager are wrapped with " +
    "newcclosure when the executor provides it. Unsupported executor APIs return a structured error rather than " +
    "silently claiming success. Use press-key for the simpler keyboard-only case.",
  category: "GUI",
  mutatesState: true,
  input: z.object({
    action: z.enum(ACTIONS).describe("The virtual input operation to perform."),
    key: z
      .string()
      .optional()
      .describe(
        "Exact Enum.KeyCode member name for keyDown, keyUp, or keyPress, such as W, Space, or LeftShift.",
      ),
    x: z
      .number()
      .finite()
      .optional()
      .describe("Screen X coordinate, or horizontal relative delta for mouseMove."),
    y: z
      .number()
      .finite()
      .optional()
      .describe("Screen Y coordinate, or vertical relative delta for mouseMove."),
    relative: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "For mouseMove, use executor relative movement when true; otherwise use absolute screen coordinates.",
      ),
    button: z
      .enum(["Left", "Right", "Middle"])
      .optional()
      .default("Left")
      .describe("Mouse button for mouseButton."),
    buttonAction: z
      .enum(["down", "up", "click"])
      .optional()
      .default("click")
      .describe("Whether mouseButton sends down, up, or a down/up click."),
    delta: z.number().finite().optional().default(0).describe("Wheel delta for mouseWheel."),
    holdSec: z
      .number()
      .finite()
      .nonnegative()
      .optional()
      .default(0)
      .describe(
        "Seconds to hold keyPress or a mouse click between down and up, capped at 10 seconds.",
      ),
    touchId: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Touch identifier for touch."),
    touchState: z
      .enum(["Begin", "Change", "End"])
      .optional()
      .default("Begin")
      .describe("Touch phase."),
    gamepad: z
      .enum(["Gamepad1", "Gamepad2", "Gamepad3", "Gamepad4"])
      .optional()
      .default("Gamepad1")
      .describe("Gamepad input device."),
    gamepadButton: z
      .string()
      .optional()
      .describe(
        "Exact Enum.KeyCode member name for a gamepad button, such as ButtonA or ButtonStart.",
      ),
    gamepadDown: z.boolean().optional().default(true).describe("Pressed state for gamepadButton."),
    axis: z
      .string()
      .optional()
      .describe(
        "Exact Enum.KeyCode member name for a gamepad axis, such as Thumbstick1 or ButtonL2.",
      ),
    axisX: z.number().finite().optional().default(0).describe("Gamepad axis X/value component."),
    axisY: z.number().finite().optional().default(0).describe("Gamepad axis Y/value component."),
    axisZ: z.number().finite().optional().default(0).describe("Gamepad axis Z/value component."),
    threadContext: z.number().int().optional(),
  }),
  async execute(
    {
      action,
      key,
      x,
      y,
      relative,
      button,
      buttonAction,
      delta,
      holdSec,
      touchId,
      touchState,
      gamepad,
      gamepadButton,
      gamepadDown,
      axis,
      axisX,
      axisY,
      axisZ,
      threadContext,
    },
    ctx,
  ) {
    const hold = Math.min(holdSec, 10);
    const source = `
local action = ${q(action)}
local keyName = ${q(key ?? "")}
local x = ${x === undefined ? "nil" : String(x)}
local y = ${y === undefined ? "nil" : String(y)}
local relative = ${relative ? "true" : "false"}
local buttonName = ${q(button)}
local buttonAction = ${q(buttonAction)}
local delta = ${String(delta)}
local holdSec = ${String(hold)}
local touchId = ${String(touchId)}
local touchStateName = ${q(touchState)}
local gamepadName = ${q(gamepad)}
local gamepadButtonName = ${q(gamepadButton ?? "")}
local gamepadDown = ${gamepadDown ? "true" : "false"}
local axisName = ${q(axis ?? "")}
local axisX = ${String(axisX)}
local axisY = ${String(axisY)}
local axisZ = ${String(axisZ)}

local function waitFor(seconds)
  if seconds > 0 and type(task) == "table" and type(task.wait) == "function" then
    pcall(task.wait, seconds)
  end
end

-- Some executors reject calls originating from a normal Lua closure. Wrap the
-- actual native call in newcclosure when available, while keeping a portable
-- identity fallback for executors that do not expose it.
local function invokeNative(fn)
  local callable = fn
  if type(newcclosure) == "function" then
    local okWrap, wrapped = pcall(newcclosure, fn)
    if okWrap and type(wrapped) == "function" then callable = wrapped end
  end
  return pcall(callable)
end

local okService, vim = pcall(function() return game:GetService("VirtualInputManager") end)
if not okService or typeof(vim) ~= "Instance" then vim = nil end

local function enumItem(enumType, name)
  local ok, item = pcall(function() return enumType[name] end)
  if not ok or typeof(item) ~= "EnumItem" then return nil end
  return item
end

local function fail(message)
  return { ok = false, action = action, error = message }
end

local function sendKey(isDown)
  local keyCode = enumItem(Enum.KeyCode, keyName)
  if not keyCode then return false, "unknown Enum.KeyCode '" .. keyName .. "'" end
  if vim then
    local ok, err = invokeNative(function() vim:SendKeyEvent(isDown, keyCode, false, game) end)
    if ok then return true end
    return false, "VirtualInputManager:SendKeyEvent failed: " .. tostring(err)
  end
  if #keyName == 1 and type(keypress) == "function" and type(keyrelease) == "function" then
    local byte = string.byte(keyName:upper())
    local ok, err = invokeNative(function()
      if isDown then keypress(byte) else keyrelease(byte) end
    end)
    if ok then return true end
    return false, "keypress/keyrelease failed: " .. tostring(err)
  end
  return false, "VirtualInputManager is unavailable and no compatible key fallback exists"
end

local mouseButtonId = { Left = 0, Right = 1, Middle = 2 }
local function sendMouseButton(isDown)
  if x == nil or y == nil then return false, "mouseButton requires x and y" end
  local id = mouseButtonId[buttonName]
  if id == nil then return false, "unknown mouse button '" .. buttonName .. "'" end
  if vim then
    local ok, err = invokeNative(function() vim:SendMouseButtonEvent(x, y, id, isDown, game, 0) end)
    if ok then return true end
    return false, "VirtualInputManager:SendMouseButtonEvent failed: " .. tostring(err)
  end
  local fallback = ({ Left = isDown and mouse1press or mouse1release, Right = isDown and mouse2press or mouse2release, Middle = isDown and mouse3press or mouse3release })
  if type(fallback) == "function" then
    local ok, err = invokeNative(fallback)
    if ok then return true end
    return false, "mouse button fallback failed: " .. tostring(err)
  end
  return false, "VirtualInputManager is unavailable and no compatible mouse-button fallback exists"
end

if action == "keyDown" or action == "keyUp" then
  local ok, err = sendKey(action == "keyDown")
  if not ok then return fail(err) end
elseif action == "keyPress" then
  local ok, err = sendKey(true)
  if not ok then return fail(err) end
  waitFor(holdSec)
  ok, err = sendKey(false)
  if not ok then return fail(err .. " (key may be stuck down)") end
elseif action == "mouseMove" then
  if x == nil or y == nil then return fail("mouseMove requires x and y") end
  local ok, err
  if relative and type(mousemoverel) == "function" then
    ok, err = invokeNative(function() mousemoverel(x, y) end)
  elseif not relative and type(mousemoveabs) == "function" then
    ok, err = invokeNative(function() mousemoveabs(x, y) end)
  elseif vim and not relative then
    ok, err = invokeNative(function() vim:SendMouseMoveEvent(x, y, game) end)
  else
    return fail(relative and "relative mouse movement requires mousemoverel in this executor" or "VirtualInputManager is unavailable and no absolute mouse fallback exists")
  end
  if not ok then return fail("mouse movement failed: " .. tostring(err)) end
elseif action == "mouseButton" then
  if buttonAction == "down" or buttonAction == "click" then
    local ok, err = sendMouseButton(true)
    if not ok then return fail(err) end
  end
  if buttonAction == "click" then waitFor(holdSec) end
  if buttonAction == "up" or buttonAction == "click" then
    local ok, err = sendMouseButton(false)
    if not ok then return fail(err .. " (mouse button may be stuck down)") end
  end
elseif action == "mouseWheel" then
  if x == nil or y == nil then return fail("mouseWheel requires x and y") end
  if not vim then return fail("mouseWheel requires VirtualInputManager in this executor") end
  local ok, err = invokeNative(function() vim:SendMouseWheelEvent(x, y, delta, game) end)
  if not ok then return fail("VirtualInputManager:SendMouseWheelEvent failed: " .. tostring(err)) end
elseif action == "touch" then
  if x == nil or y == nil then return fail("touch requires x and y") end
  if not vim then return fail("touch requires VirtualInputManager in this executor") end
  local state = enumItem(Enum.UserInputState, touchStateName)
  if not state then return fail("unknown Enum.UserInputState '" .. touchStateName .. "'") end
  local ok, err = invokeNative(function() vim:SendTouchEvent(touchId, state, x, y, game) end)
  if not ok then return fail("VirtualInputManager:SendTouchEvent failed: " .. tostring(err)) end
elseif action == "gamepadButton" then
  if gamepadButtonName == "" then return fail("gamepadButton requires gamepadButton") end
  if not vim then return fail("gamepadButton requires VirtualInputManager in this executor") end
  local inputType = enumItem(Enum.UserInputType, gamepadName)
  local keyCode = enumItem(Enum.KeyCode, gamepadButtonName)
  if not inputType then return fail("unknown Enum.UserInputType '" .. gamepadName .. "'") end
  if not keyCode then return fail("unknown Enum.KeyCode '" .. gamepadButtonName .. "'") end
  local ok, err = invokeNative(function() vim:SendGamepadButtonEvent(inputType, keyCode, gamepadDown, game) end)
  if not ok then return fail("VirtualInputManager:SendGamepadButtonEvent failed: " .. tostring(err)) end
elseif action == "gamepadAxis" then
  if axis == nil or axis == "" then return fail("gamepadAxis requires axis") end
  if not vim then return fail("gamepadAxis requires VirtualInputManager in this executor") end
  local inputType = enumItem(Enum.UserInputType, gamepadName)
  local keyCode = enumItem(Enum.KeyCode, axisName)
  if not inputType then return fail("unknown Enum.UserInputType '" .. gamepadName .. "'") end
  if not keyCode then return fail("unknown Enum.KeyCode '" .. axisName .. "'") end
  local ok, err = invokeNative(function() vim:SendGamepadAxisEvent(inputType, keyCode, axisX, axisY, axisZ, game) end)
  if not ok then return fail("VirtualInputManager:SendGamepadAxisEvent failed: " .. tostring(err)) end
end

return { ok = true, action = action, usedVirtualInputManager = vim ~= nil, usedNewcclosure = type(newcclosure) == "function" }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
