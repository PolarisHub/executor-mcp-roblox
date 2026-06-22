import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, q, REFLECT_PRELUDE } from "../_shared/reflection.js";

const valueArgSchema = z
  .object({
    kind: z
      .enum(["string", "number", "boolean", "nil", "raw"])
      .describe(
        "How to interpret `value`. 'string'/'number'/'boolean' write that literal scalar. 'nil' clears the attribute " +
          "(passes nil to SetAttribute, removing it; ignores `value`). 'raw' treats `value` as a Luau expression — " +
          "REQUIRED for non-primitive attribute types Roblox allows (Vector3, CFrame, Color3, UDim, UDim2, Rect, " +
          "NumberRange, NumberSequence, ColorSequence, BrickColor, Font, EnumItem). Note: attributes only accept those " +
          "types plus string/number/boolean — Instances are NOT valid attribute values.",
      ),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .describe(
        "The literal value (for string/number/boolean) or, when kind='raw', a Luau expression string such as " +
          "'Vector3.new(0,50,0)', 'Color3.fromRGB(255,0,0)', 'UDim2.new(0,100,0,100)', or 'NumberRange.new(1,5)'. " +
          "Omit entirely when kind='nil' to delete the attribute.",
      )
      .optional(),
  })
  .describe("The new attribute value to write, expressed as a typed argument.");

export default defineTool({
  name: "set-attribute",
  title: "Set (or clear) a custom attribute on a live Instance",
  description:
    "WRITES LIVE GAME STATE. Resolve a Luau expression to an Instance and write one of its custom attributes via " +
    "inst:SetAttribute(name, value), returning both the OLD and NEW value so the change is auditable. Attributes are " +
    "the named, typed key/value pairs games store on instances (visible in the Studio Attributes panel and read with " +
    ":GetAttribute) — distinct from engine properties (use set-instance-property for those). Common uses while " +
    "debugging: flip a 'IsAdmin'/'Frozen' boolean attribute, bump a 'Cooldown'/'Damage' number, or set a 'State' " +
    "string. For non-primitive attribute types use value.kind='raw'; use kind='nil' to DELETE the attribute. The read " +
    "of the old value and the write are each pcall-guarded. WARNING: this mutates the running game on the client — the " +
    "change takes effect immediately and may replicate, and game scripts listening on GetAttributeChangedSignal will " +
    "fire. Returns { Path, Attribute, OldValue, NewValue, ok } or { error }.",
  category: "Actions",
  mutatesState: true,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau expression resolving to the Instance whose attribute you want to set, e.g. 'game.Workspace.Part', " +
          "'game.Players.LocalPlayer', or 'game:GetService(\"Workspace\").Boss'. Evaluated as `return <instancePath>`.",
      ),
    attributeName: z
      .string()
      .describe(
        "The exact attribute name to write, e.g. 'IsAdmin', 'Cooldown', 'State'. Case-sensitive. If the attribute " +
          "does not exist yet it will be created; passing value.kind='nil' deletes it.",
      ),
    value: valueArgSchema,
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, attributeName, value, threadContext }, ctx) {
    const newValueExpr = buildValueExpr(value);
    const source = `
${REFLECT_PRELUDE}
local inst, err = __eval(${q(instancePath)})
if err then return { error = err } end
if typeof(inst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(inst) .. "): " .. ${q(instancePath)} } end

local attr = ${q(attributeName)}
if type(inst.SetAttribute) ~= "function" or type(inst.GetAttribute) ~= "function" then
  return { error = "this Instance does not support attributes (GetAttribute/SetAttribute missing)." }
end

local oldEnc = nil
local okRead, oldVal = pcall(function() return inst:GetAttribute(attr) end)
if okRead then oldEnc = __encVal(oldVal) end

local okSet, setErr = pcall(function() inst:SetAttribute(attr, ${newValueExpr}) end)
if not okSet then return { error = "failed to set attribute '" .. attr .. "': " .. tostring(setErr) } end

local newEnc = nil
local okRead2, newVal = pcall(function() return inst:GetAttribute(attr) end)
if okRead2 then newEnc = __encVal(newVal) end

local path = ${q(instancePath)}
local okName, full = pcall(function() return inst:GetFullName() end)
if okName then path = full end

return {
  Path = path,
  Attribute = attr,
  OldValue = oldEnc,
  NewValue = newEnc,
  ok = true,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
