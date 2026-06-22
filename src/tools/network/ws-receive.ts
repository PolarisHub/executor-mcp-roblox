import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Drain the inbound-frame ring buffer for a WebSocket opened by ws-connect. The
 * OnMessage handler installed by ws-connect appends { text, t } records into
 * getgenv().__mcp_ws[id].messages; this returns them newest-first, capped at `limit`,
 * and optionally clears the ring afterwards. Read-only with respect to game state
 * (it only reads, or empties, the server-side buffer).
 */
export default defineTool({
  name: "ws-receive",
  title: "Read buffered WebSocket frames",
  description:
    "Read the inbound frames buffered for a WebSocket opened with ws-connect, addressed by its registry id. Returns the " +
    "captured { text, t } records newest-first, capped at `limit`, plus whether the socket is still open and the total " +
    "buffered count. With clear=true the ring is emptied after the snapshot is taken, so the next call only sees newer " +
    "frames. Requires getgenv and the entry from ws-connect — guarded, returning { error } when the id is unknown. " +
    "Returns { id, open, messageCount, messages } or { error }.",
  category: "Network",
  input: z.object({
    id: z.number().int().describe("The WebSocket registry id returned by ws-connect."),
    limit: z
      .number()
      .int()
      .describe("Max frames to return, newest-first (default 100).")
      .optional()
      .default(100),
    clear: z
      .boolean()
      .describe("When true, empty the buffered frames after returning them (default false).")
      .optional()
      .default(false),
    threadContext: z.number().int().optional(),
  }),
  async execute({ id, limit, clear, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 200);
    const source = `
if type(getgenv) ~= "function" then
  return { error = "getgenv is not available; cannot access the WebSocket registry." }
end
local __g = getgenv()
if type(__g.__mcp_ws) ~= "table" then
  return { error = "No WebSocket registry exists. Open a socket with ws-connect first." }
end

local id = ${Math.floor(id)}
local entry = __g.__mcp_ws[id]
if not entry then
  return { error = "No WebSocket with id " .. tostring(id) .. ". Open one with ws-connect first." }
end

local ring = entry.messages or {}
local total = #ring
local out = {}
for i = total, math.max(1, total - ${lim} + 1), -1 do
  out[#out + 1] = ring[i]
end
if ${clear ? "true" : "false"} then
  entry.messages = {}
end
return { id = id, open = entry.open == true, messageCount = total, messages = out }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
