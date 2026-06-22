import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "find-function-xrefs",
  title: "Find xrefs TO a function (IDA 'xrefs to')",
  description:
    "Resolve a target Luau FUNCTION from an expression, then walk every function in the GC and report which ones " +
    "REFERENCE it — the runtime equivalent of IDA's 'cross references to' on a sub. A referrer references the target " +
    "if the target appears in its upvalues (closures that captured it) OR among its nested protos (functions that " +
    "embed it as an inner function). Each xref reports __fnInfo (ptr/name/source/line/nparams/nups) plus 'via' " +
    '("upvalue" or "proto"). The target itself is skipped. Requires getgc + getupvalues/getprotos; caps the scan ' +
    "and flags truncation. Pivot from list-gc-functions or lookup-function to get an expression that resolves here.",
  category: "Disassembly & Xrefs",
  input: z.object({
    functionPath: z
      .string()
      .describe(
        "Luau expression that resolves to the TARGET function, e.g. " +
          "'getrenv().game.ReplicatedStorage.Modules.Combat.attack' or 'require(path).onHit'. " +
          "Evaluated as `(loadstring('return '..expr))()`; must yield type=='function' or the tool errors.",
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
  async execute({ functionPath, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 1000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 30000);
    const source = `
${XREF_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local expr = ${q(functionPath)}
local loader = loadstring or load
if type(loader) ~= "function" then return { error = "loadstring/load is not available in this executor." } end
local okc, chunk = pcall(loader, "return " .. expr)
if not okc or type(chunk) ~= "function" then
  return { error = "Failed to compile expression: " .. tostring(chunk) }
end
local okr, target = pcall(chunk)
if not okr then return { error = "Error evaluating expression: " .. tostring(target) } end
if type(target) ~= "function" then
  return { error = "Expression did not resolve to a function (got " .. typeof(target) .. ")." }
end

local xrefs = {}
local count = 0
local capped = false
local trunc, scanned = __eachFn(${cap}, function(fn)
  if fn == target then return end
  local via = nil
  for _, u in __ups(fn) do
    if u == target then via = "upvalue"; break end
  end
  if not via then
    for _, p in __protos(fn) do
      if p == target then via = "proto"; break end
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
  target = __fnInfo(target),
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
