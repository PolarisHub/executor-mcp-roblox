import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, q, REFLECT_PRELUDE } from "../_shared/reflection.js";

const valueArgSchema = z
  .object({
    kind: z
      .enum(["string", "number", "boolean", "nil", "raw"])
      .describe(
        "How to interpret `value`. 'string'/'number'/'boolean' pass that literal scalar. 'nil' passes nil (ignores " +
          "`value`). 'raw' treats `value` as a Luau expression — use for non-primitive arguments (Vector3, Color3, " +
          "Enum, Instance references, etc.).",
      ),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .describe(
        "The literal value (for string/number/boolean) or, when kind='raw', a Luau expression string such as " +
          "'Vector3.new(0,50,0)', 'Enum.Material.Neon', or 'game.Workspace.Part'. Omit entirely when kind='nil'.",
      )
      .optional(),
  })
  .describe("A single method argument, expressed as a typed value.");

export default defineTool({
  name: "invoke-method",
  title: "Call a method on a live Instance",
  description:
    "ACTS ON LIVE GAME STATE. Resolve a Luau expression to an Instance and call one of its methods as a colon-call " +
    "(inst:Method(args...)), returning whatever the method returns. Useful while debugging for :Destroy(), " +
    ":GetChildren(), :FindFirstChild(name), :Clone(), :GetAttribute(name), :SetAttribute(name, value), " +
    ":WaitForChild(name), Humanoid:TakeDamage(n), Humanoid:MoveTo(pos), Tool:Activate(), etc. Each argument is a " +
    "typed value; use kind='raw' for non-primitive arguments (Vector3, Enum, Instance, ...). The call is " +
    "pcall-guarded. WARNING: many methods MUTATE the game (e.g. :Destroy(), :SetAttribute, :TakeDamage) and the " +
    "effect is immediate and may replicate — only call methods you understand. Returns { Path, Method, ok, " +
    "ReturnValues } or { error }.",
  category: "Actions",
  mutatesState: true,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau expression resolving to the Instance to call the method on, e.g. 'game.Workspace.Part', " +
          "'game.Players.LocalPlayer.Character.Humanoid', or 'game:GetService(\"Lighting\")'. Evaluated as " +
          "`return <instancePath>`.",
      ),
    methodName: z
      .string()
      .describe(
        "The exact method name to call (case-sensitive), e.g. 'Destroy', 'GetChildren', 'FindFirstChild', " +
          "'Clone', 'GetAttribute', 'SetAttribute', 'TakeDamage'. Invoked as a colon-call so `self` is the instance.",
      ),
    args: z
      .array(valueArgSchema)
      .describe(
        "Ordered list of arguments passed to the method after `self`. Omit or pass [] for a no-argument call like " +
          ":Destroy() or :GetChildren().",
      )
      .optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, methodName, args, threadContext }, ctx) {
    const argExprs = (args ?? []).map(buildValueExpr);
    const argList = argExprs.join(", ");
    const source = `
${REFLECT_PRELUDE}
local inst, err = __eval(${q(instancePath)})
if err then return { error = err } end
if typeof(inst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(inst) .. "): " .. ${q(instancePath)} } end

local method = ${q(methodName)}
local fn = inst[method]
if type(fn) ~= "function" then return { error = "'" .. method .. "' is not a callable method on this Instance (got " .. typeof(fn) .. ")." } end

local path = ${q(instancePath)}
local okName, full = pcall(function() return inst:GetFullName() end)
if okName then path = full end

local results = table.pack(pcall(function() return inst[method](inst${argList ? ", " + argList : ""}) end))
local okCall = results[1]
if not okCall then return { error = "method '" .. method .. "' raised an error: " .. tostring(results[2]) } end

local returns = {}
for i = 2, results.n do returns[#returns + 1] = __encVal(results[i]) end

return {
  Path = path,
  Method = method,
  ok = true,
  ReturnValues = returns,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
