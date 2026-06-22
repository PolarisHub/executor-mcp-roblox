import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "find-upvalue-sharing",
  title: "Find functions sharing the same upvalue table (closure clusters)",
  description:
    "Walk every Luau function in the GC and, for each function, inspect its upvalues. Whenever an upvalue is a TABLE, " +
    "record the owning function under that table's identity. After scanning, report tables that are shared as an " +
    "upvalue by several distinct functions — these are typically the shared state / private module table of a single " +
    "closure family, so the functions that share it belong to the same module or factory. This is how you cluster " +
    "functions that were defined together (a module's methods all close over the same private table). Each entry " +
    "reports the table identity, how many functions share it, and a few sample functions. Requires getgc + " +
    "getupvalues; caps the scan and flags truncation.",
  category: "Disassembly & Xrefs",
  input: z.object({
    minGroup: z
      .number()
      .int()
      .describe(
        "Only report tables shared as an upvalue by at least this many distinct functions (default 3).",
      )
      .optional()
      .default(3),
    limit: z
      .number()
      .int()
      .describe("Max shared tables to return, most-shared first (default 40).")
      .optional()
      .default(40),
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
if type(__getupvalues) ~= "function" then return { error = "getupvalues is not available in this executor." } end

local shared = {}
local minG = ${minG}
local trunc, scanned = __eachFn(${cap}, function(fn)
  local seen = {}
  for _, uv in __ups(fn) do
    if type(uv) == "table" then
      local key = tostring(uv)
      -- Count each function once per distinct table, even if it has the table
      -- in multiple upvalue slots.
      if not seen[key] then
        seen[key] = true
        local e = shared[key]
        if not e then e = { count = 0, samples = {} }; shared[key] = e end
        e.count = e.count + 1
        if #e.samples < 4 then e.samples[#e.samples + 1] = __fnInfo(fn) end
      end
    end
  end
end)

local arr = {}
for key, e in shared do
  if e.count >= minG then
    arr[#arr + 1] = { table = key, sharedBy = e.count, sampleFns = e.samples }
  end
end
table.sort(arr, function(a, b) return a.sharedBy > b.sharedBy end)
local out = {}
for i = 1, math.min(#arr, ${lim}) do out[i] = arr[i] end
return {
  sharedTables = out,
  totalSharedTables = #arr,
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
