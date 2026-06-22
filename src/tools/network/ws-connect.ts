import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Open a real WebSocket from inside the game client via the sUNC `WebSocket.connect`
 * API. The live socket can't cross the bridge, so it is parked in a getgenv registry
 * (`getgenv().__mcp_ws`) keyed by an integer id; ws-send / ws-receive / ws-close /
 * ws-list operate on that id across later tool calls. On connect we wire ws.OnMessage
 * into a capped (200) ring buffer and ws.OnClose into an `open=false` flag, so received
 * frames accumulate server-side until fetched.
 */
export default defineTool({
  name: "ws-connect",
  title: "WebSocket.connect — open a live WebSocket (Volt/sUNC)",
  description:
    "WRITES LIVE GAME STATE — opens a real outbound WebSocket from the client via WebSocket.connect(url). The live " +
    "socket is parked in a getgenv registry keyed by an integer id (returned as `id`); use that id with ws-send, " +
    "ws-receive, ws-close, and ws-list. On connect, ws.OnMessage is wired into a capped (200-frame) ring buffer and " +
    "ws.OnClose flips the entry's open flag to false, so inbound frames accumulate server-side until you fetch them. " +
    "Requires a Volt-class executor exposing the WebSocket library (type(WebSocket)=='table' with WebSocket.connect) " +
    "— both are type-guarded and the connect is pcall-wrapped, returning { error } when missing or on failure. " +
    "Returns { id, url } or { error }.",
  category: "Network",
  mutatesState: true,
  input: z.object({
    url: z
      .string()
      .describe(
        "The WebSocket URL to connect to, e.g. 'ws://127.0.0.1:8080' or 'wss://example.com/socket'.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ url, threadContext }, ctx) {
    const source = `
if type(getgenv) ~= "function" then
  return { error = "getgenv is not available; cannot maintain the WebSocket registry." }
end
if type(WebSocket) ~= "table" or type(WebSocket.connect) ~= "function" then
  return { error = "WebSocket.connect is not available in this executor." }
end

local __g = getgenv()
if type(__g.__mcp_ws) ~= "table" then __g.__mcp_ws = {} end
if type(__g.__mcp_ws_counter) ~= "number" then __g.__mcp_ws_counter = 0 end

local ok, socket = pcall(WebSocket.connect, ${q(url)})
if not ok or socket == nil then
  return { error = "WebSocket.connect failed: " .. tostring(socket) }
end

__g.__mcp_ws_counter = __g.__mcp_ws_counter + 1
local id = __g.__mcp_ws_counter
local entry = { socket = socket, url = ${q(url)}, messages = {}, open = true, max = 200 }
__g.__mcp_ws[id] = entry

pcall(function()
  socket.OnMessage:Connect(function(message)
    local e = __g.__mcp_ws[id]
    if not e then return end
    local ring = e.messages
    ring[#ring + 1] = { text = tostring(message), t = os.clock() }
    if #ring > e.max then table.remove(ring, 1) end
  end)
end)
pcall(function()
  socket.OnClose:Connect(function()
    local e = __g.__mcp_ws[id]
    if e then e.open = false end
  end)
end)

return { id = id, url = ${q(url)} }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
