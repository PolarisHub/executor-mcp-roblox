import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "find-global-xrefs",
  title: "Find functions that reference a global or method by name",
  description:
    "Find functions that likely call or reference this global or method by name. Luau bytecode stores global lookups and " +
    "method names (e.g. FireServer, require, loadstring, HttpGet, GetService) as string constants, so this walks every " +
    "function in the GC and reports each one whose constants contain the exact name string. This is the IDA xref-to-import " +
    "equivalent: pivot from a sensitive API to all the code that uses it. Each hit reports the owning script source, line, " +
    "function name and pointer. Requires getgc + getconstants; caps the scan and flags truncation.",
  category: "Disassembly & Xrefs",
  input: z.object({
    name: z
      .string()
      .describe(
        "The exact global or method name to look for (e.g. FireServer, require, loadstring, HttpGet, GetService).",
      ),
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
  async execute({ name, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 1000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 30000);
    const source = `
${XREF_PRELUDE}
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local name = ${q(name)}
local lim = ${lim}
local matches = {}
local matchCount = 0
local trunc, scanned = __eachFn(${cap}, function(fn)
  local matched = false
  for _, c in __consts(fn) do
    if type(c) == "string" and c == name then
      matched = true
      break
    end
  end
  if matched then
    matchCount = matchCount + 1
    if #matches < lim then
      local info = __fnInfo(fn)
      matches[#matches + 1] = {
        source = info.source,
        line = info.line,
        name = info.name,
        ptr = info.ptr,
      }
    end
  end
end)

return { name = name, matchCount = matchCount, functionsScanned = scanned, truncatedScan = trunc, matches = matches }
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
