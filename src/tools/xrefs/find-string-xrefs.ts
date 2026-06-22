import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "find-string-xrefs",
  title: "Find xrefs to a string (IDA xref-to-string)",
  description:
    "Cross-reference a string the way IDA jumps from a string literal to every place it is used. Walks every Luau " +
    "function in the GC and reports each function that has the query as a string constant in its bytecode — i.e. each " +
    "function that likely produces or compares against that text. Use exact=true for an exact match, otherwise it does a " +
    "plain substring search (case-sensitive). Each hit reports the owning script source, line, function name and pointer, " +
    "plus the first matching constant. Great for pivoting from list-strings to the code that references a remote name, URL, " +
    "error message, or anti-cheat tag. Requires getgc + getconstants; caps the scan and flags truncation.",
  category: "Disassembly & Xrefs",
  input: z.object({
    query: z
      .string()
      .describe("The string to cross-reference (e.g. a remote name, URL, or error message)."),
    exact: z
      .boolean()
      .describe(
        "If true, only match constants that equal the query exactly. If false (default), match any constant that contains the query as a substring (case-sensitive).",
      )
      .optional()
      .default(false),
    limit: z
      .number()
      .int()
      .describe("Max matching functions to return (default 100).")
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
  async execute({ query, exact, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 1000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 30000);
    const source = `
${XREF_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local query = ${q(query)}
local exact = ${exact ? "true" : "false"}
local lim = ${lim}
local matches = {}
local matchCount = 0
local trunc, scanned = __eachFn(${cap}, function(fn)
  local matched = nil
  for _, c in __consts(fn) do
    if type(c) == "string" and ((exact and c == query) or (not exact and string.find(c, query, 1, true))) then
      matched = c
      break
    end
  end
  if matched ~= nil then
    matchCount = matchCount + 1
    if #matches < lim then
      local info = __fnInfo(fn)
      matches[#matches + 1] = {
        source = info.source,
        line = info.line,
        name = info.name,
        ptr = info.ptr,
        matchedConstant = matched,
      }
    end
  end
end)

return { query = query, exact = exact, matchCount = matchCount, functionsScanned = scanned, truncatedScan = trunc, matches = matches }
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
