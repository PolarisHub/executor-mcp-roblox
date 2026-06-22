import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Send a text frame over a WebSocket opened by ws-connect, addressed by its registry
 * id (`getgenv().__mcp_ws[id]`). Guards that the entry exists and is still open before
 * calling socket:Send(message).
 */
export default defineTool({
  name: "ws-send",
  title: "ws:Send — send a frame over an open WebSocket",
  description:
    "WRITES LIVE GAME STATE — sends a text frame over a WebSocket previously opened with ws-connect, addressed by its " +
    "registry id. Looks up getgenv().__mcp_ws[id], verifies the socket is still open, and calls socket:Send(message). " +
    "Requires getgenv and the live socket from ws-connect — both are guarded and the send is pcall-wrapped, returning " +
    "{ error } when the id is unknown, the socket is closed, or Send fails. Returns { id, sent = true } or { error }.",
  category: "Network",
  mutatesState: true,
  input: z.object({
    id: z.number().int().describe("The WebSocket registry id returned by ws-connect."),
    message: z.string().describe("The text frame to send over the socket."),
    threadContext: z.number().int().optional(),
  }),
  async execute({ id, message, threadContext }, ctx) {
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
if not entry.open then
  return { error = "WebSocket " .. tostring(id) .. " is closed." }
end
if type(entry.socket) ~= "userdata" and type(entry.socket) ~= "table" then
  return { error = "WebSocket " .. tostring(id) .. " has no live socket." }
end

local ok, err = pcall(function() entry.socket:Send(${q(message)}) end)
if not ok then
  return { error = "ws:Send failed: " .. tostring(err) }
end
return { id = id, sent = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
