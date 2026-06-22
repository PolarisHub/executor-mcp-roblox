import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "find-duplicate-functions",
  title: "Find identical / duplicated functions (IDA find-identical)",
  description:
    "Walk every Luau function in the GC, hash each one with getfunctionhash, and group functions that share the " +
    "exact same hash — the runtime equivalent of IDA's 'find identical functions'. Reveals clones and copy-pasted " +
    "code (duplicated module logic, repeated handlers, library functions instantiated many times). Each group reports " +
    "the shared hash, how many functions carry it, and a few sample functions (ptr/name/source/line). Requires " +
    "getgc + getfunctionhash; caps the scan and flags truncation.",
  category: "Disassembly & Xrefs",
  input: z.object({
    minGroup: z
      .number()
      .int()
      .describe(
        "Only report hash groups shared by at least this many functions (default 2 = any duplicate).",
      )
      .optional()
      .default(2),
    limit: z
      .number()
      .int()
      .describe("Max duplicate groups to return, largest groups first (default 50).")
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
  async execute({ minGroup, limit, maxScan, threadContext }, ctx) {
    const minG = Math.max(2, Math.floor(minGroup));
    const lim = Math.min(Math.max(Math.floor(limit), 1), 1000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 30000);
    const source = `
${XREF_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end
if type(getfunctionhash) ~= "function" then return { error = "getfunctionhash is not available in this executor." } end

local groups = {}
local minG = ${minG}
local trunc, scanned = __eachFn(${cap}, function(fn)
  local ok, h = pcall(getfunctionhash, fn)
  if ok and type(h) == "string" and #h > 0 then
    local e = groups[h]
    if not e then e = { count = 0, samples = {} }; groups[h] = e end
    e.count = e.count + 1
    if #e.samples < 5 then e.samples[#e.samples + 1] = __fnInfo(fn) end
  end
end)

local arr = {}
for h, e in groups do
  if e.count >= minG then
    arr[#arr + 1] = { hash = h, count = e.count, samples = e.samples }
  end
end
table.sort(arr, function(a, b) return a.count > b.count end)
local out = {}
for i = 1, math.min(#arr, ${lim}) do out[i] = arr[i] end
return {
  duplicateGroups = out,
  totalDuplicateGroups = #arr,
  functionsScanned = scanned,
  truncatedScan = trunc,
}
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
