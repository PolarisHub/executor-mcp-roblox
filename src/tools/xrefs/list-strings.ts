import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "list-strings",
  title: "List all string constants (IDA Strings window)",
  description:
    "Walk every Luau function in the GC and collect their string constants — the runtime equivalent of IDA's " +
    "Strings window. Reports each unique string, how many functions reference it (xref count), and a sample owning " +
    "script, sorted by frequency. Filter by substring and minimum length to cut noise. Great for finding interesting " +
    "literals (remote names, URLs, error messages, anti-cheat tags) and then pivoting with find-string-xrefs. " +
    "Requires getgc + getconstants; caps the scan and flags truncation.",
  category: "Disassembly & Xrefs",
  input: z.object({
    filter: z
      .string()
      .describe(
        "Only include strings containing this substring (case-sensitive). Empty = all strings.",
      )
      .optional()
      .default(""),
    minLength: z
      .number()
      .int()
      .describe("Ignore strings shorter than this (default 4) to cut noise.")
      .optional()
      .default(4),
    limit: z
      .number()
      .int()
      .describe("Max unique strings to return, most-referenced first (default 200).")
      .optional()
      .default(200),
    maxScan: z
      .number()
      .int()
      .describe("Max GC functions to scan (default 9000).")
      .optional()
      .default(9000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ filter, minLength, limit, maxScan, threadContext }, ctx) {
    const minLen = Math.max(1, Math.floor(minLength));
    const lim = Math.min(Math.max(Math.floor(limit), 1), 1000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 30000);
    const source = `
${XREF_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local strings = {}
local filter = ${q(filter)}
local minLen = ${minLen}
local trunc, scanned = __eachFn(${cap}, function(fn)
  for _, c in __consts(fn) do
    if type(c) == "string" and #c >= minLen and (filter == "" or string.find(c, filter, 1, true)) then
      local e = strings[c]
      if not e then e = { count = 0, sample = __fnInfo(fn).source }; strings[c] = e end
      e.count = e.count + 1
    end
  end
end)

local arr = {}
for s, e in strings do arr[#arr + 1] = { value = s, xrefs = e.count, sampleSource = e.sample } end
table.sort(arr, function(a, b) return a.xrefs > b.xrefs end)
local out = {}
for i = 1, math.min(#arr, ${lim}) do out[i] = arr[i] end
return { uniqueStrings = #arr, functionsScanned = scanned, truncatedScan = trunc, strings = out }
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
