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
          "'game.Workspace'. Omit entirely when kind='nil'.",
      )
      .optional(),
  })
  .describe("The value to write for this property, expressed as a typed argument.");

const propertySchema = z
  .object({
    name: z
      .string()
      .describe(
        "The exact property name to set on the new instance (case-sensitive), e.g. 'Anchored', 'Size', 'BrickColor'.",
      ),
    value: valueArgSchema,
  })
  .describe("A single property to assign on the newly-created instance.");

export default defineTool({
  name: "create-instance",
  title: "Create a new Instance in the live game",
  description:
    "WRITES LIVE GAME STATE. Construct a brand-new Instance via Instance.new(className), optionally set its Name and a " +
    "list of initial properties, and optionally parent it into the game tree. Useful while debugging for spawning a " +
    "Part, a Highlight/BillboardGui ESP marker, a Folder, a Value object (IntValue/StringValue/BoolValue), or any " +
    "other class. PROCESS: Instance.new is pcall-guarded (returns a clean error if className is invalid); Name is set " +
    "if provided; each property is set independently and pcall-guarded so one bad property does not abort the others " +
    "(failures are collected into propErrors); Parent is set LAST (only if parentPath is given) so all properties are " +
    "applied before the instance becomes live in the tree. If you do NOT pass parentPath the instance is created but " +
    "left parentless (nil) — it still exists in memory and can be parented later via set-instance-property on its " +
    "Parent. WARNING: a parented instance immediately affects the running game and may replicate. Returns " +
    "{ Created, ClassName, Parented, propErrors, ok } or { error }.",
  category: "Actions",
  mutatesState: true,
  input: z.object({
    className: z
      .string()
      .describe(
        "The Roblox class name to instantiate, e.g. 'Part', 'Folder', 'Highlight', 'BillboardGui', 'IntValue', " +
          "'StringValue', 'ScreenGui'. Passed to Instance.new(className); an unknown/non-creatable class returns a " +
          "clean error.",
      ),
    name: z
      .string()
      .describe(
        "Optional Name to assign to the new instance. If omitted the engine's default name for the class is kept.",
      )
      .optional(),
    parentPath: z
      .string()
      .describe(
        "Optional Luau expression resolving to the Instance that should become the new instance's Parent, e.g. " +
          "'game.Workspace', 'game.Players.LocalPlayer.PlayerGui', or 'game:GetService(\"ReplicatedStorage\")'. " +
          "Evaluated as `return <parentPath>`. Set LAST, after all properties. Omit to leave the instance parentless.",
      )
      .optional(),
    properties: z
      .array(propertySchema)
      .describe(
        "Optional list of initial properties to assign before parenting, e.g. " +
          "[{ name: 'Anchored', value: { kind: 'boolean', value: true } }, " +
          "{ name: 'Size', value: { kind: 'raw', value: 'Vector3.new(4,1,4)' } }]. Omit or pass [] for none.",
      )
      .optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ className, name, parentPath, properties, threadContext }, ctx) {
    const props = properties ?? [];
    const propAssignments = props
      .map(
        (p) =>
          `do
  local pname = ${q(p.name)}
  local okP, errP = pcall(function() __new[pname] = ${buildValueExpr(p.value)} end)
  if not okP then propErrors[#propErrors + 1] = { name = pname, error = tostring(errP) } end
end`,
      )
      .join("\n");

    const source = `
${REFLECT_PRELUDE}
local className = ${q(className)}
local okNew, __new = pcall(function() return Instance.new(className) end)
if not okNew then return { error = "Instance.new(\\"" .. className .. "\\") failed: " .. tostring(__new) } end
if typeof(__new) ~= "Instance" then return { error = "Instance.new did not return an Instance for className: " .. className } end

${name !== undefined ? `pcall(function() __new.Name = ${q(name)} end)` : ""}

local propErrors = {}
${propAssignments}

local parented = false
${
  parentPath !== undefined
    ? `do
  local parent, perr = __eval(${q(parentPath)})
  if perr then
    propErrors[#propErrors + 1] = { name = "Parent", error = perr }
  elseif typeof(parent) ~= "Instance" then
    propErrors[#propErrors + 1] = { name = "Parent", error = "parentPath did not resolve to an Instance (got " .. typeof(parent) .. ")" }
  else
    local okPar, parErr = pcall(function() __new.Parent = parent end)
    if okPar then parented = true else propErrors[#propErrors + 1] = { name = "Parent", error = tostring(parErr) } end
  end
end`
    : ""
}

local created = __new.Name
local okName, full = pcall(function() return __new:GetFullName() end)
if okName then created = full end

local cls = __new.ClassName

return {
  Created = created,
  ClassName = cls,
  Parented = parented,
  propErrors = propErrors,
  ok = true,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
