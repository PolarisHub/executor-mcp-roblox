import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, PRELUDE } from "../_shared/luau.js";

export default defineTool({
  name: "batch-execute",
  title: "Run many Luau snippets in order in one call",
  description:
    "Run several independent Luau snippets in sequence in a single round trip, collecting every result without paying " +
    "a separate tool call per snippet. Each snippet is COMPILED with loadstring and run under its own pcall, in input " +
    "order; a compile or runtime error in one snippet is recorded for that snippet only and never aborts the others. " +
    "For each snippet you get { index, ok, value? , error? } — `value` is the FIRST return value, encoded so " +
    "Instances/Vector3/etc. survive serialization; `error` carries the compile or runtime message when ok is false. " +
    "Use this to read several instances, probe multiple remotes, or run a short script of steps in one shot. Requires " +
    "loadstring (guarded). Returns { results = [{ index, ok, value?, error? }] } in input order.",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    snippets: z
      .array(z.string())
      .min(1)
      .describe(
        "The Luau snippets to run, in order. Each is compiled and pcall-guarded independently; to capture a value, " +
          "`return` it (only the first return value is collected).",
      ),
    client: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Run on a specific connected client — its clientId OR username — for THIS call only, " +
          "overriding your session's select-client binding without changing it. Lets multiple agents drive " +
          "different games at the same time; omit to use your session's selected client.",
      ),
    agent: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. A stable label for WHICH agent is calling when several share this MCP session (e.g. " +
          "'researcher'). Gives that agent its own fair scheduling lane, its own persistent VM on each game, and " +
          "its own queue budget, so co-tenant agents don't starve or clobber each other.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  async execute({ snippets, threadContext, timeoutMs }, ctx) {
    const snippetLines = snippets
      .map((snippet, i) => `__snippets[${i + 1}] = ${q(snippet)}`)
      .join("\n");

    const source = `
${PRELUDE}
if type(loadstring) ~= "function" then return { error = "loadstring is not available in this executor." } end

local __snippets = {}
${snippetLines}

local __results = {}
for __i = 1, #__snippets do
  local __src = __snippets[__i]
  local __fn, __cerr = loadstring(__src, "=batch-execute[" .. tostring(__i) .. "]")
  if not __fn then
    __results[__i] = { index = __i, ok = false, error = "compile error: " .. tostring(__cerr) }
  else
    local __packed = table.pack(pcall(__fn))
    if __packed[1] then
      local __okEnc, __enc = pcall(__encode, __packed[2])
      __results[__i] = { index = __i, ok = true, value = __okEnc and __enc or nil }
    else
      __results[__i] = { index = __i, ok = false, error = "runtime error: " .. tostring(__packed[2]) }
    end
  end
end

return { results = __results }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
