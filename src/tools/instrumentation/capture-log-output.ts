import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "capture-log-output",
  title: "Capture all print/warn/error log output over a window (MUTATES STATE via LogService)",
  description:
    "WRITES LIVE GAME STATE — INSTALLS A PERSISTENT LOG CONNECTION. Connects LogService.MessageOut and records every " +
    "line the game emits (print, warn, error, and engine messages) into a ring buffer, so you can later read everything " +
    "that was logged during a window of play. This is the best way to watch a game's own console output over time — see " +
    "what a script prints when you trigger an action, catch errors/stack traces as they happen, or correlate warnings " +
    "with behavior. It uses a signal CONNECTION (LogService.MessageOut), NOT a function hook, so it is low-risk compared " +
    "to the hook-based instrument tools.\n\n" +
    "WORKFLOW (stateful — survives across tool calls via getgenv().__mcp_logCapture):\n" +
    "  1. action='start' — connects MessageOut to a handler that pushes { message (first 500 chars), messageType, t } " +
    "into a 1000-entry ring buffer. Returns { started }.\n" +
    "  2. action='fetch' — returns the captured messages (newest-bounded by `limit`) WITHOUT clearing them; poll while " +
    "you play. Returns { count, returned, entries }.\n" +
    "  3. action='stop' — Disconnects the connection and clears state. Returns { stopped, captured }.\n\n" +
    "CAVEATS: the connection PERSISTS until you stop it (or the client restarts) and fires on every logged line, so a " +
    "noisy game fills the 1000-entry buffer (oldest dropped). Each message is truncated to 500 chars. Always stop when " +
    "done. Requires game:GetService('LogService') and getgenv. Returns { error } if a capability is missing, or " +
    "{ notRunning } for fetch/stop when nothing is active.",
  category: "Instrumentation",
  mutatesState: false,
  input: z.object({
    action: z
      .enum(["start", "fetch", "stop"])
      .describe(
        "'start' connects LogService.MessageOut and begins capturing log lines (persistent until stopped); 'fetch' " +
          "returns captured messages WITHOUT clearing them (poll while you play); 'stop' disconnects and clears all " +
          "captured state.",
      ),
    limit: z
      .number()
      .int()
      .describe(
        "fetch only: maximum number of messages to return, newest first (default 200, capped at the 1000-entry buffer).",
      )
      .optional()
      .default(200),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, limit, threadContext }, ctx) {
    const prelude = `
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor; cannot maintain the log-capture registry." } end
local __genv = getgenv()
`;

    let body: string;
    let timeoutMs = 15000;

    if (action === "start") {
      body = `
local okSvc, logService = pcall(function() return game:GetService("LogService") end)
if not okSvc or typeof(logService) ~= "Instance" then return { error = "Could not get LogService." } end

local st = __genv.__mcp_logCapture
if type(st) == "table" and st.conn then
  return { alreadyRunning = true, count = (st.log and #st.log) or 0 }
end

st = { log = {}, max = 1000, conn = nil, startedAt = (type(os) == "table" and os.clock and os.clock()) or 0 }
__genv.__mcp_logCapture = st

local okConn, conn = pcall(function()
  return logService.MessageOut:Connect(function(message, messageType)
    local s = __genv.__mcp_logCapture
    if not s or not s.log then return end
    pcall(function()
      local msg = tostring(message)
      if #msg > 500 then msg = string.sub(msg, 1, 500) end
      local mt
      local okmt, t = pcall(tostring, messageType)
      mt = okmt and t or "Unknown"
      local log = s.log
      log[#log + 1] = {
        message = msg,
        messageType = mt,
        t = (type(os) == "table" and os.clock and os.clock()) or 0,
      }
      if #log > s.max then table.remove(log, 1) end
    end)
  end)
end)

if not okConn or typeof(conn) ~= "RBXScriptConnection" then
  __genv.__mcp_logCapture = nil
  return { error = "Failed to connect LogService.MessageOut: " .. tostring(conn) }
end

st.conn = conn
return { started = true, max = st.max }
`;
    } else if (action === "fetch") {
      const lim = Math.min(Math.max(Math.floor(limit ?? 200), 1), 1000);
      body = `
local st = __genv.__mcp_logCapture
if type(st) ~= "table" then return { notRunning = true, count = 0, entries = {} } end

local log = st.log or {}
local total = #log
local limit = ${lim}
local entries = {}
local taken = 0
-- Walk newest -> oldest, capped at limit.
for i = total, 1, -1 do
  if taken >= limit then break end
  taken = taken + 1
  entries[taken] = log[i]
end
return { count = total, returned = taken, max = st.max, truncated = total > taken, entries = entries }
`;
      timeoutMs = 20000;
    } else {
      body = `
local st = __genv.__mcp_logCapture
if type(st) ~= "table" then return { notRunning = true } end

local disconnected = false
if st.conn then
  local okd = pcall(function() st.conn:Disconnect() end)
  disconnected = okd == true
end

local captured = (st.log and #st.log) or 0
__genv.__mcp_logCapture = nil
return { stopped = true, disconnected = disconnected, captured = captured }
`;
    }

    const source = prelude + body;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
