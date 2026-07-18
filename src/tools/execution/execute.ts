import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "execute",
  title: "Execute Code in the Roblox Game Client",
  description:
    "Execute Luau in the active Roblox client WITHOUT waiting for it to finish. The code is COMPILED FIRST via " +
    "loadstring (a syntax error is returned cleanly as { error } and nothing runs), then handed to task.spawn so it " +
    "runs on its own thread; this tool returns { scheduled = true } the moment the thread is started — it does NOT " +
    "wait for completion and does NOT return the code's output, return value, or runtime errors. Use this for " +
    "fire-and-forget side effects. When you need the value(s) your code produces, use run-luau or execute-and-wait " +
    "instead. Requires loadstring and the task library (both guarded). Returns { scheduled = true } or { error }.",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    code: z
      .string()
      .describe(
        "The Luau code to execute in the Roblox client. Compiled with loadstring, then spawned on its own thread. " +
          "This tool does NOT return output — use run-luau or execute-and-wait if you need data back.",
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
  async execute({ code, threadContext, timeoutMs }, ctx) {
    const source = `
if type(loadstring) ~= "function" then return { error = "loadstring is not available in this executor." } end
if type(task) ~= "table" or type(task.spawn) ~= "function" then
  return { error = "task.spawn is not available in this executor." }
end

local __fn, __cerr = loadstring(${q(code)}, "=execute")
if not __fn then return { error = "compile error: " .. tostring(__cerr) } end

-- Wrap so a runtime error in the detached thread can never destabilize the
-- scheduler; the snippet runs unobserved and its result is not awaited.
local __ok, __err = pcall(task.spawn, function() pcall(__fn) end)
if not __ok then return { error = "task.spawn failed: " .. tostring(__err) } end

return { scheduled = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
