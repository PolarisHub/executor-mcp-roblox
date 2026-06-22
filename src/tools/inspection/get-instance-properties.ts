import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, PRELUDE, RESOLVE_PRELUDE } from "../_shared/luau.js";

export default defineTool({
  name: "get-instance-properties",
  title: "Read an instance's common properties and attributes",
  description:
    "Resolve a single instance from a dotted path (e.g. 'game.Workspace.Part') and read a useful core set of its " +
    "properties plus all of its attributes. Each property is pcall-read independently, so ones that don't exist on " +
    "the class are simply omitted rather than failing the call. Returns { path, fullName, className, properties, " +
    "attributes } with each property as { type, value }, or { error } if the path does not resolve. " +
    "For listing many instances use get-instance-tree instead.",
  category: "Inspection",
  input: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        "Dotted path to the instance, starting at 'game' (e.g. 'game.Players.LocalPlayer.PlayerGui').",
      ),
  }),
  async execute({ path }, ctx) {
    const source = `
${PRELUDE}
${RESOLVE_PRELUDE}
local COMMON = {
  "Name", "ClassName", "Parent",
  "Enabled", "Visible", "Active", "Text", "Value", "PlaceholderText",
  "Position", "Size", "CFrame", "Anchored", "CanCollide", "Orientation",
  "Transparency", "Color", "BrickColor", "Material",
  "Health", "MaxHealth", "WalkSpeed", "Adornee", "Image",
  "BackgroundColor3", "TextColor3", "Disabled", "Archivable",
}

local inst, err = __resolve(${q(path)})
if not inst then
  return { error = err or "Failed to resolve path", path = ${q(path)} }
end
if typeof(inst) ~= "Instance" then
  return { error = "Resolved value is not an Instance (got " .. typeof(inst) .. ")", path = ${q(path)} }
end

local props = {}
for _, name in ipairs(COMMON) do
  local ok, value = pcall(function() return (inst :: any)[name] end)
  if ok and value ~= nil then
    props[name] = { type = typeof(value), value = __encode(value) }
  end
end

local attributes = {}
local okAttr, attrs = pcall(function() return inst:GetAttributes() end)
if okAttr and type(attrs) == "table" then
  for k, v in pairs(attrs) do
    attributes[tostring(k)] = { type = typeof(v), value = __encode(v) }
  end
end

local fullName = inst.Name
do
  local ok, f = pcall(function() return inst:GetFullName() end)
  if ok then fullName = f end
end

return {
  path = ${q(path)},
  fullName = fullName,
  className = inst.ClassName,
  properties = props,
  attributes = attributes,
  ok = true,
}
`;
    const result = (await ctx.runLuau(source)) as {
      error?: string;
      className?: string;
      properties?: Record<string, unknown>;
    };
    if (result?.error) {
      return { data: result, summary: result.error, isError: true };
    }
    const count = result?.properties ? Object.keys(result.properties).length : 0;
    return {
      data: result,
      summary: `${result?.className ?? "Instance"}: ${count} propert${count === 1 ? "y" : "ies"}.`,
    };
  },
});
