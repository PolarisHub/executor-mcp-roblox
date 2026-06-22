import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "list-gui-elements",
  title: "List GUI elements under a root",
  description:
    "Enumerate the live GUI tree under a root Instance (defaults to the LocalPlayer's PlayerGui) and return a flat " +
    "list of every GuiObject it contains. This is the fastest way to discover what UI is actually on screen — the " +
    "exact paths, classes and current Text — so you can then read or drive a specific element with get-gui-text, " +
    "set-gui-text, click-button or type-text-box. Walks root:GetDescendants() with each property access pcall-guarded " +
    "so a single hostile element never aborts the scan. For every descendant that is (or, with classFilter, exactly " +
    "matches) a GuiObject it records { path = GetFullName(), class = ClassName, name = Name, Visible, Text } where " +
    "Visible and Text are only present when readable. Output is capped at `limit`; when more elements exist than the " +
    "cap, `truncated` is true. Returns { count, truncated, elements } or { error }.",
  category: "GUI",
  input: z.object({
    root: z
      .string()
      .describe(
        "Luau expression resolving to the Instance whose descendant GUI tree to list. Defaults to " +
          "'game:GetService(\"Players\").LocalPlayer.PlayerGui'. Pass a deeper expression such as " +
          "'game:GetService(\"CoreGui\")' or 'game.Players.LocalPlayer.PlayerGui.MainMenu' to scope the walk. " +
          "Evaluated as `return <root>`.",
      )
      .optional()
      .default('game:GetService("Players").LocalPlayer.PlayerGui'),
    classFilter: z
      .string()
      .describe(
        "Optional exact ClassName to keep, e.g. 'TextButton', 'TextLabel', 'TextBox', 'ImageButton', 'Frame'. " +
          "When set, only descendants whose ClassName equals this string are returned. When omitted, every GuiObject " +
          "(IsA('GuiObject')) is returned. Case-sensitive.",
      )
      .optional(),
    limit: z
      .number()
      .int()
      .describe(
        "Maximum number of elements to return (default 200). The walk stops adding once this many matches are " +
          "collected and sets `truncated` to true so you know to scope the root or filter more tightly.",
      )
      .optional()
      .default(200),
    threadContext: z.number().int().optional(),
  }),
  async execute({ root, classFilter, limit, threadContext }, ctx) {
    const cap = Math.min(Math.max(Math.floor(limit ?? 200), 1), 5000);
    const filterExpr = classFilter ? q(classFilter) : "nil";
    const source = `
${REFLECT_PRELUDE}
local rootInst, err = __eval(${q(root)})
if err then return { error = err } end
if typeof(rootInst) ~= "Instance" then return { error = "root did not resolve to an Instance (got " .. typeof(rootInst) .. "): " .. ${q(root)} } end

local classFilter = ${filterExpr}
local cap = ${cap}

local okDesc, descendants = pcall(function() return rootInst:GetDescendants() end)
if not okDesc or type(descendants) ~= "table" then return { error = "failed to read GetDescendants() of root: " .. tostring(descendants) } end

local elements = {}
local count = 0
local truncated = false

for _, inst in ipairs(descendants) do
  local keep = false
  if classFilter ~= nil then
    local okC, cn = pcall(function() return inst.ClassName end)
    keep = okC and (cn == classFilter)
  else
    local okIs, isGui = pcall(function() return inst:IsA("GuiObject") end)
    keep = okIs and isGui == true
  end

  if keep then
    if count >= cap then truncated = true break end
    count = count + 1

    local rec = {}
    local okPath, full = pcall(function() return inst:GetFullName() end)
    rec.path = okPath and full or tostring(inst)
    local okClass, cn = pcall(function() return inst.ClassName end)
    if okClass then rec.class = cn end
    local okName, nm = pcall(function() return inst.Name end)
    if okName then rec.name = nm end
    local okVis, vis = pcall(function() return inst.Visible end)
    if okVis and type(vis) == "boolean" then rec.Visible = vis end
    local okText, txt = pcall(function() return inst.Text end)
    if okText and type(txt) == "string" then rec.Text = txt end

    elements[count] = rec
  end
end

return { count = count, truncated = truncated, elements = elements }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
