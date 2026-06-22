import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-gui-text",
  title: "Read the text of a GUI element",
  description:
    "Resolve a Luau expression to a single GUI Instance and return whichever text properties it actually exposes: " +
    ".Text (the editable/displayed string on TextLabels, TextButtons and TextBoxes), .ContentText (the rendered " +
    "text after rich-text/markup processing) and .PlaceholderText (the grey hint shown by an empty TextBox). Use " +
    "this to inspect exactly what a label says or what a player has typed before acting on it. Each property read " +
    "is independently pcall-guarded, so missing properties are simply omitted rather than erroring — a Frame with " +
    "no text fields returns just { Path }. Pair with list-gui-elements to first discover the path. " +
    "Returns { Path, Text?, ContentText?, PlaceholderText? } or { error }.",
  category: "GUI",
  input: z.object({
    path: z
      .string()
      .describe(
        "Luau expression resolving to the GUI Instance to read, e.g. " +
          "'game.Players.LocalPlayer.PlayerGui.Shop.PriceLabel' or " +
          "'game:GetService(\"Players\").LocalPlayer.PlayerGui.Login.UsernameBox'. Evaluated as `return <path>`.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ path, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
local inst, err = __eval(${q(path)})
if err then return { error = err } end
if typeof(inst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(inst) .. "): " .. ${q(path)} } end

local result = {}
local okPath, full = pcall(function() return inst:GetFullName() end)
result.Path = okPath and full or ${q(path)}

local okText, txt = pcall(function() return inst.Text end)
if okText and type(txt) == "string" then result.Text = txt end

local okContent, content = pcall(function() return inst.ContentText end)
if okContent and type(content) == "string" then result.ContentText = content end

local okPlace, place = pcall(function() return inst.PlaceholderText end)
if okPlace and type(place) == "string" then result.PlaceholderText = place end

return result
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
