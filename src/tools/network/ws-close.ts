import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Close a WebSocket opened by ws-connect and drop its registry slot. Calls
 * socket:Close() (guarded), flips the entry's open flag to false, and removes
 * getgenv().__mcp_ws[id] so the id is no longer listed.
 */
export default defineTool({
  name: "ws-close",
  title: "ws:Close — close a WebSocket and free its slot",
  description:
    "WRITES LIVE GAME STATE — closes a WebSocket previously opened with ws-connect, addressed by its registry id. Calls " +
    "socket:Close() (pcall-wrapped), marks the entry closed, and removes it from the getgenv registry so the id no " +
    "longer appears in ws-list. Requires getgenv and the entry from ws-connect — guarded, returning { error } when the " +
    "id is unknown. Returns { id, closed = true } or { error }.",
  category: "Network",
  mutatesState: true,
  input: z.object({
    id: z.number().int().describe("The WebSocket registry id returned by ws-connect."),
    threadContext: z.number().int().optional(),
  }),
  async execute({ id, threadContext }, ctx) {
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
  return { error = "No WebSocket with id " .. tostring(id) .. "." }
end

pcall(function()
  if entry.socket and type(entry.socket.Close) == "function" then
    entry.socket:Close()
  end
end)
entry.open = false
__g.__mcp_ws[id] = nil
return { id = id, closed = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
