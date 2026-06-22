import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "get-remote-spy-logs",
  title: "Read the buffered remote-spy calls (newest first)",
  description:
    "Read-only. Returns the calls captured by the global remote spy (install it first with ensure-remote-spy) from " +
    "getgenv().__mcp_remoteSpy.logs, newest first and capped at `limit`. Each entry is " +
    "{ method, remote, class, args, argCount, argsTruncated, blocked, t } where `remote` is the remote's full path, " +
    "`args` is a shallow-encoded snapshot of up to 8 arguments, and `blocked` is true if the spy dropped that call " +
    "(because block-remote had blocked the remote). The legacy get-remote-spy-logs was a Cobalt connector wrapper; " +
    "this reads the self-contained getgenv ring buffer instead. Fetching does NOT clear the buffer, so you can poll " +
    "repeatedly while you play; empty it with clear-remote-spy-logs. Returns " +
    "{ active, count, returned, max, truncated, logs } when the spy exists, or { notRunning, count=0, logs={} } when " +
    "it has not been installed.",
  category: "Remote Spy",
  input: z.object({
    limit: z
      .number()
      .int()
      .describe(
        "Maximum number of log entries to return, newest first (default 100, clamped to 1..5000). The buffer is not " +
          "modified — fetching is repeatable.",
      )
      .optional()
      .default(100),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, threadContext }, ctx) {
    const cap = Math.min(Math.max(Math.floor(limit ?? 100), 1), 5000);
    const source = `
if type(getgenv) ~= "function" then return { error = "getgenv not available" } end
local genv = getgenv()
local st = genv.__mcp_remoteSpy
if type(st) ~= "table" or type(st.logs) ~= "table" then
  return { notRunning = true, count = 0, returned = 0, logs = {} }
end

local logs = st.logs
local total = #logs
local limit = ${cap}
local out = {}
local taken = 0
-- Newest -> oldest, capped at limit.
for i = total, 1, -1 do
  if taken >= limit then break end
  taken = taken + 1
  out[taken] = logs[i]
end

return {
  active = st.active == true,
  count = total,
  returned = taken,
  max = st.max,
  truncated = taken < total,
  logs = out,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
