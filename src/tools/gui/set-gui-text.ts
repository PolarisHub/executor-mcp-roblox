import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "set-gui-text",
  title: "Set the .Text of a GUI element",
  description:
    "WRITES LIVE GAME STATE. Resolve a Luau expression to a GUI Instance and overwrite its .Text property, returning " +
    "both the OLD and NEW text so the change is auditable. Use this to directly poke a value into a TextLabel, " +
    "TextButton or TextBox without simulating keystrokes — e.g. to pre-fill a login/search box or change a label " +
    "while debugging UI logic. This sets the raw .Text directly and does NOT fire FocusLost / text-changed input " +
    "events, so scripts that react only to player typing may not run; use type-text-box with useKeyPress when you " +
    "need real keystroke side-effects. The read of the old text and the write are each pcall-guarded. WARNING: this " +
    "mutates the running client UI immediately. Returns { Path, OldText, NewText, ok } or { error }.",
  category: "GUI",
  mutatesState: true,
  input: z.object({
    path: z
      .string()
      .describe(
        "Luau expression resolving to the GUI Instance whose .Text to set, e.g. " +
          "'game.Players.LocalPlayer.PlayerGui.Login.UsernameBox'. Evaluated as `return <path>`. The resolved " +
          "Instance must have a writable .Text property (TextLabel / TextButton / TextBox).",
      ),
    text: z
      .string()
      .describe("The new string to assign to the element's .Text property. Written verbatim."),
    threadContext: z.number().int().optional(),
  }),
  async execute({ path, text, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
local inst, err = __eval(${q(path)})
if err then return { error = err } end
if typeof(inst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(inst) .. "): " .. ${q(path)} } end

local oldText = nil
local okRead, ov = pcall(function() return inst.Text end)
if okRead and type(ov) == "string" then oldText = ov end

local okSet, setErr = pcall(function() inst.Text = ${q(text)} end)
if not okSet then return { error = "failed to set .Text: " .. tostring(setErr) } end

local newText = nil
local okRead2, nv = pcall(function() return inst.Text end)
if okRead2 and type(nv) == "string" then newText = nv end

local okPath, full = pcall(function() return inst:GetFullName() end)

return {
  Path = okPath and full or ${q(path)},
  OldText = oldText,
  NewText = newText,
  ok = true,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
