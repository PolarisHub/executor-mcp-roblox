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
          "'Vector3.new(0,50,0)', 'Color3.new(1,0,0)', 'Enum.Material.Neon', or 'game.Workspace'. Omit entirely when " +
          "kind='nil'.",
      )
      .optional(),
  })
  .describe("The new value to write for this property, expressed as a typed argument.");

const propertySchema = z
  .object({
    name: z
      .string()
      .describe(
        "The exact property name to write (case-sensitive), e.g. 'Anchored', 'Transparency', 'Size', 'Position'.",
      ),
    value: valueArgSchema,
  })
  .describe("A single property assignment: a name plus a typed value.");

export default defineTool({
  name: "set-properties-bulk",
  title: "Set many properties on one live Instance in a single call",
  description:
    "WRITES LIVE GAME STATE. Resolve a Luau expression to a single Instance ONCE, then apply a list of property " +
    "writes to it in order. For each property the OLD value is read, the new value is written, and the NEW value is " +
    "read back — each step pcall-guarded so one bad property never aborts the others. This is the efficient way to " +
    "reconfigure an instance with several changes at once (e.g. make a Part Anchored + CanCollide=false + " +
    "Transparency=0.5 + a new Size in one round-trip) instead of issuing many set-instance-property calls. The writes " +
    "happen sequentially within the same execution so the result is effectively atomic from the game's perspective " +
    "for that frame. WARNING: this mutates the running game on the client — changes take effect immediately and may " +
    "replicate. Returns { Path, results:[{ name, OldValue, NewValue, ok, error? }], okCount, failCount }, or " +
    "{ error } if the instance itself cannot be resolved.",
  category: "Actions",
  mutatesState: true,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau expression resolving to the single Instance to modify, e.g. 'game.Workspace.Part', " +
          "'game.Players.LocalPlayer.Character.Humanoid', or 'game:GetService(\"Lighting\")'. Evaluated once as " +
          "`return <instancePath>`.",
      ),
    properties: z
      .array(propertySchema)
      .min(1)
      .describe(
        "Non-empty, ordered list of property assignments to apply, e.g. " +
          "[{ name: 'Anchored', value: { kind: 'boolean', value: true } }, " +
          "{ name: 'Transparency', value: { kind: 'number', value: 0.5 } }, " +
          "{ name: 'Size', value: { kind: 'raw', value: 'Vector3.new(4,1,4)' } }]. Applied top-to-bottom.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, properties, threadContext }, ctx) {
    const propBlocks = properties
      .map(
        (p) =>
          `do
  local pname = ${q(p.name)}
  local entry = { name = pname }
  local okRead, oldVal = pcall(function() return inst[pname] end)
  if okRead then entry.OldValue = __encVal(oldVal) end
  local okSet, setErr = pcall(function() inst[pname] = ${buildValueExpr(p.value)} end)
  if okSet then
    entry.ok = true
    okCount = okCount + 1
    local okRead2, newVal = pcall(function() return inst[pname] end)
    if okRead2 then entry.NewValue = __encVal(newVal) end
  else
    entry.ok = false
    entry.error = tostring(setErr)
    failCount = failCount + 1
  end
  results[#results + 1] = entry
end`,
      )
      .join("\n");

    const source = `
${REFLECT_PRELUDE}
local inst, err = __eval(${q(instancePath)})
if err then return { error = err } end
if typeof(inst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(inst) .. "): " .. ${q(instancePath)} } end

local path = ${q(instancePath)}
local okName, full = pcall(function() return inst:GetFullName() end)
if okName then path = full end

local results = {}
local okCount = 0
local failCount = 0

${propBlocks}

return {
  Path = path,
  results = results,
  okCount = okCount,
  failCount = failCount,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
