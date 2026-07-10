import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "type-text-box",
  title: "Type into a TextBox",
  description:
    "WRITES LIVE GAME STATE. Enter text into a Roblox TextBox by path. Resolves the path to a TextBox, captures its " +
    "focus, then either simulates real keystrokes (useKeyPress=true, via VirtualInputManager:SendTextInput with a " +
    "keypress/keyrelease fallback) so text-changed and FocusLost handlers run, or directly sets the .Text property " +
    "(useKeyPress=false). Optionally presses Enter afterwards and releases focus. Use the keystroke path when scripts " +
    "react to player typing; use the direct path for a fast value poke. Returns { Path, ok } or { error }.",
  category: "GUI",
  mutatesState: true,
  input: z.object({
    path: z.string().describe("The instance path to the TextBox"),
    text: z.string().describe("The string to type into the TextBox"),
    enter: z.boolean().describe("Whether to press Enter after typing").optional().default(false),
    useKeyPress: z
      .boolean()
      .describe(
        "If true, simulates real keystrokes using VirtualInputManager / keypress. If false, directly sets the Text property.",
      )
      .optional()
      .default(true),
    threadContext: z.number().int().optional(),
  }),
  async execute({ path, text, enter, useKeyPress, threadContext }, ctx) {
    const source = `
local okEval, textBox = pcall(function() return (loadstring("return " .. ${q(path)}))() end)
if not okEval then return { error = "failed to evaluate path: " .. tostring(textBox) } end

if typeof(textBox) ~= "Instance" then return { error = "Path did not resolve to a valid Instance." } end
local okIs, isBox = pcall(function() return textBox:IsA("TextBox") end)
if not okIs or not isBox then return { error = "Resolved Instance is not a TextBox." } end

local text = ${q(text)}
local enter = ${enter ? "true" : "false"}
local useKeyPress = ${useKeyPress ? "true" : "false"}

local function invokeNative(fn)
  if type(newcclosure) == "function" then
    local okWrap, wrapped = pcall(newcclosure, fn)
    if okWrap and type(wrapped) == "function" then fn = wrapped end
  end
  return pcall(fn)
end

pcall(function() textBox:CaptureFocus() end)
if type(task) == "table" and type(task.wait) == "function" then pcall(task.wait, 0.05) end

if useKeyPress then
  local okSvc, vim = pcall(function() return game:GetService("VirtualInputManager") end)
  local success = false
  if okSvc and typeof(vim) == "Instance" then
    success = invokeNative(function()
      for i = 1, #text do
        vim:SendTextInput(text:sub(i, i), nil, game)
        if type(task) == "table" and type(task.wait) == "function" then task.wait(0.01) end
      end
    end)
  end

  if not success and type(keypress) == "function" then
    for i = 1, #text do
      local char = text:sub(i, i):upper()
      local byte = char:byte()
      if byte then
        pcall(keypress, byte)
        if type(task) == "table" and type(task.wait) == "function" then pcall(task.wait, 0.01) end
        if type(keyrelease) == "function" then pcall(keyrelease, byte) end
      end
    end
  end
else
  local okSet, setErr = pcall(function() textBox.Text = text end)
  if not okSet then return { error = "failed to set .Text: " .. tostring(setErr) } end
end

if enter then
  if useKeyPress then
    if type(keypress) == "function" then
      pcall(keypress, 0x0D)
      if type(task) == "table" and type(task.wait) == "function" then pcall(task.wait, 0.01) end
      if type(keyrelease) == "function" then pcall(keyrelease, 0x0D) end
    else
      pcall(function()
        local vim = game:GetService("VirtualInputManager")
        invokeNative(function() vim:SendKeyEvent(true, Enum.KeyCode.Return, false, game) end)
        if type(task) == "table" and type(task.wait) == "function" then task.wait(0.01) end
        invokeNative(function() vim:SendKeyEvent(false, Enum.KeyCode.Return, false, game) end)
      end)
    end
  end
  pcall(function() textBox:ReleaseFocus(true) end)
else
  pcall(function() textBox:ReleaseFocus(false) end)
end

local okPath, full = pcall(function() return textBox:GetFullName() end)

return { Path = okPath and full or ${q(path)}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
