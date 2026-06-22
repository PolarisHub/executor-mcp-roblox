import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "find-functions-by-complexity",
  title: "Find the most complex functions (RE starting points)",
  description:
    "Rank every Luau function in the GC by complexity so you know where to start reverse-engineering — the biggest, most " +
    "interesting functions usually carry the core logic. For each function it counts the number of constants, upvalues, and " +
    "nested protos, then returns the top `limit` by the chosen metric (sortBy), heaviest first. Each entry reports the owning " +
    "script source, line, function name and pointer, plus the three counts. Pivot from here with get-closure-constants / " +
    "find-string-xrefs / call-graph tools. Requires getgc + getconstants/getupvalues/getprotos; caps the scan and flags truncation.",
  category: "Disassembly & Xrefs",
  input: z.object({
    sortBy: z
      .enum(["constants", "upvalues", "protos"])
      .describe(
        "Which complexity metric to rank by: 'constants' (literals/strings/numbers used, default), 'upvalues' (captured variables), or 'protos' (nested child functions).",
      )
      .optional()
      .default("constants"),
    limit: z
      .number()
      .int()
      .describe("Max functions to return, heaviest first (default 50).")
      .optional()
      .default(50),
    maxScan: z
      .number()
      .int()
      .describe("Max GC functions to scan (default 9000).")
      .optional()
      .default(9000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ sortBy, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 1000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 30000);
    const source = `
${XREF_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local sortBy = ${JSON.stringify(sortBy)}
local lim = ${lim}
local arr = {}
local trunc, scanned = __eachFn(${cap}, function(fn)
  local info = __fnInfo(fn)
  arr[#arr + 1] = {
    source = info.source,
    line = info.line,
    name = info.name,
    ptr = info.ptr,
    constants = #__consts(fn),
    upvalues = #__ups(fn),
    protos = #__protos(fn),
  }
end)

table.sort(arr, function(a, b) return a[sortBy] > b[sortBy] end)
local out = {}
for i = 1, math.min(#arr, lim) do out[i] = arr[i] end
return { sortBy = sortBy, functionsScanned = scanned, truncatedScan = trunc, functions = out }
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
