import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "find-instance-xrefs",
  title: "Find functions that reference an Instance (IDA data xrefs)",
  description:
    "Resolve a target Instance from a Luau expression, then walk every function in the GC and report which ones hold " +
    "a reference to it — the runtime equivalent of IDA's data cross-references on a global object. A referrer " +
    "references the instance if it appears in the function's upvalues OR constants. Answers 'which functions read, " +
    "manipulate, or watch this object?'. Each xref reports __fnInfo (ptr/name/source/line/nparams/nups) plus 'via' " +
    '("upvalue" or "constant"). Requires getgc + getupvalues/getconstants; caps the scan and flags truncation.',
  category: "Disassembly & Xrefs",
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau expression that resolves to the target Instance, e.g. " +
          "'game.Workspace.Boss' or 'game:GetService(\"Players\").LocalPlayer.Character'. " +
          "Evaluated as `(loadstring('return '..expr))()`; must yield typeof=='Instance' or the tool errors.",
      ),
    limit: z
      .number()
      .int()
      .describe("Max referrer functions (xrefs) to return (default 100).")
      .optional()
      .default(100),
    maxScan: z
      .number()
      .int()
      .describe("Max GC functions to scan (default 9000).")
      .optional()
      .default(9000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 1000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 30000);
    const source = `
${XREF_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local expr = ${q(instancePath)}
local loader = loadstring or load
if type(loader) ~= "function" then return { error = "loadstring/load is not available in this executor." } end
local okc, chunk = pcall(loader, "return " .. expr)
if not okc or type(chunk) ~= "function" then
  return { error = "Failed to compile expression: " .. tostring(chunk) }
end
local okr, target = pcall(chunk)
if not okr then return { error = "Error evaluating expression: " .. tostring(target) } end
if typeof(target) ~= "Instance" then
  return { error = "Expression did not resolve to an Instance (got " .. typeof(target) .. ")." }
end

local fullName = target:GetFullName()
local okfn, fn2 = pcall(function() return target:GetFullName() end)
if okfn then fullName = fn2 end

local xrefs = {}
local count = 0
local capped = false
local trunc, scanned = __eachFn(${cap}, function(fn)
  local via = nil
  for _, u in __ups(fn) do
    if u == target then via = "upvalue"; break end
  end
  if not via then
    for _, c in __consts(fn) do
      if c == target then via = "constant"; break end
    end
  end
  if via then
    count = count + 1
    if #xrefs < ${lim} then
      local info = __fnInfo(fn)
      info.via = via
      xrefs[#xrefs + 1] = info
    else
      capped = true
    end
  end
end)

return {
  instance = fullName,
  className = target.ClassName,
  xrefCount = count,
  functionsScanned = scanned,
  truncatedScan = trunc,
  truncatedOutput = capped,
  xrefs = xrefs,
}
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
