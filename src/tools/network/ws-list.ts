import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Enumerate the WebSocket registry built by ws-connect. Reports every parked entry
 * in getgenv().__mcp_ws as { id, url, open, messageCount } so callers can see which
 * sockets are live and how many inbound frames are buffered on each. Read-only.
 */
export default defineTool({
  name: "ws-list",
  title: "List open WebSockets (Volt/sUNC)",
  description:
    "List every WebSocket currently parked in the getgenv registry by ws-connect. For each entry it reports { id, url, " +
    "open, messageCount } so you can see which sockets are still live and how many inbound frames are buffered. " +
    "Read-only. Requires getgenv — guarded; when no registry exists it simply returns an empty list. Returns " +
    "{ count, sockets } or { error }.",
  category: "Network",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
if type(getgenv) ~= "function" then
  return { error = "getgenv is not available; cannot access the WebSocket registry." }
end
local __g = getgenv()
local reg = __g.__mcp_ws
if type(reg) ~= "table" then
  return { count = 0, sockets = {} }
end

local out = {}
for id, entry in pairs(reg) do
  out[#out + 1] = {
    id = id,
    url = entry.url,
    open = entry.open == true,
    messageCount = #(entry.messages or {}),
  }
end
table.sort(out, function(a, b) return a.id < b.id end)
return { count = #out, sockets = out }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
