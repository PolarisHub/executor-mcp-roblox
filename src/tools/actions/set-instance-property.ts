import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, q, REFLECT_PRELUDE } from "../_shared/reflection.js";

const valueArgSchema = z
  .object({
    kind: z
      .enum(["string", "number", "boolean", "nil", "raw"])
      .describe(
        "How to interpret `value`. 'string'/'number'/'boolean' write that literal scalar. 'nil' clears the property " +
          "(ignores `value`). 'raw' treats `value` as a Luau expression — REQUIRED for any non-primitive property type " +
          "(Vector3, CFrame, Color3, UDim2, Enum, Instance reference, etc.).",
      ),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .describe(
        "The literal value (for string/number/boolean) or, when kind='raw', a Luau expression string such as " +
          "'Vector3.new(0,50,0)', 'Color3.new(1,0,0)', 'Enum.Material.Neon', 'UDim2.new(0,100,0,100)', or " +
          "'game.Workspace.SpawnLocation'. Omit entirely when kind='nil'.",
      )
      .optional(),
  })
  .describe("The new value to write, expressed as a typed argument.");

export default defineTool({
  name: "set-instance-property",
  title: "Set a property on a live Instance",
  description:
    "WRITES LIVE GAME STATE. Resolve a Luau expression to an Instance and assign one of its properties, returning " +
    "both the OLD and NEW value so the change is auditable. Common uses while debugging: toggle a GUI's Visible, " +
    "bump a character's Humanoid WalkSpeed/JumpPower, set a part's Transparency/Anchored/CanCollide, or write an " +
    "IntValue/StringValue's Value. For non-primitive property types (Vector3, CFrame, Color3, UDim2, Enum, Instance " +
    "references) use value.kind='raw' and pass a Luau expression. The read of the old value and the write are each " +
    "pcall-guarded. WARNING: this mutates the running game on the client — the change takes effect immediately and " +
    "may replicate. Returns { Path, Property, OldValue, NewValue, ok } or { error }.",
  category: "Actions",
  mutatesState: true,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau expression resolving to the Instance to modify, e.g. 'game.Players.LocalPlayer.Character.Humanoid', " +
          "'game.Workspace.Part', or 'game:GetService(\"StarterGui\")'. Evaluated as `return <instancePath>`.",
      ),
    propertyName: z
      .string()
      .describe(
        "The exact property name to write, e.g. 'WalkSpeed', 'Visible', 'Transparency', 'Anchored', 'Value', " +
          "'Position', 'BrickColor'. Case-sensitive.",
      ),
    value: valueArgSchema,
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, propertyName, value, threadContext }, ctx) {
    const newValueExpr = buildValueExpr(value);
    const source = `
${REFLECT_PRELUDE}
local inst, err = __eval(${q(instancePath)})
if err then return { error = err } end
if typeof(inst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(inst) .. "): " .. ${q(instancePath)} } end

local prop = ${q(propertyName)}

local oldEnc = nil
local okRead, oldVal = pcall(function() return inst[prop] end)
if okRead then oldEnc = __encVal(oldVal) end

local okSet, setErr = pcall(function() inst[prop] = ${newValueExpr} end)
if not okSet then return { error = "failed to set property '" .. prop .. "': " .. tostring(setErr) } end

local newEnc = nil
local okRead2, newVal = pcall(function() return inst[prop] end)
if okRead2 then newEnc = __encVal(newVal) end

local path = inst
local okName, full = pcall(function() return inst:GetFullName() end)
if okName then path = full else path = ${q(instancePath)} end

return {
  Path = path,
  Property = prop,
  OldValue = oldEnc,
  NewValue = newEnc,
  ok = true,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
