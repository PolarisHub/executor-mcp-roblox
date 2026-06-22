import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Capture outgoing RakNet packets via raknet.add_send_hook. Volt's RakNet library
 * only exposes a SEND hook (outgoing traffic), so this logs what the client emits:
 * size, priority, reliability, ordering channel, and a hex preview of the payload.
 * Stateful start/fetch/stop, keyed in getgenv so it survives across tool calls.
 */
export default defineTool({
  name: "packet-spy",
  title: "Spy on outgoing RakNet packets (Volt)",
  description:
    "WRITES LIVE GAME STATE — installs a RakNet send hook. Captures every OUTGOING low-level packet the client " +
    "sends (RakNet only exposes outgoing traffic). For each packet it records Size, Priority, Reliability, " +
    "OrderingChannel, and a hex preview of the payload. action='start' installs the hook (idempotent), " +
    "'fetch' returns the captured packets newest-first without stopping, 'stop' removes the hook and clears the " +
    "buffer. Requires a Volt-class executor with the `raknet` library. WARNING: packet-level interception is " +
    "risky and can disconnect or flag the client — stop when done.",
  category: "Network",
  mutatesState: true,
  input: z.object({
    action: z
      .enum(["start", "fetch", "stop"])
      .describe(
        "'start' installs the send hook; 'fetch' returns captured packets; 'stop' removes the hook.",
      ),
    limit: z
      .number()
      .int()
      .describe("Max packets to return on fetch (default 100, newest-first).")
      .optional()
      .default(100),
    previewBytes: z
      .number()
      .int()
      .describe("How many payload bytes to include as a hex preview per packet (default 64).")
      .optional()
      .default(64),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, limit, previewBytes, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 500);
    const preview = Math.min(Math.max(Math.floor(previewBytes), 0), 256);
    const source = `
if type(getgenv) ~= "function" then return { error = "getgenv is not available; cannot maintain the packet spy." } end
local __g = getgenv()
if type(raknet) ~= "table" or type(raknet.add_send_hook) ~= "function" then
  return { error = "raknet.add_send_hook is not available in this executor (requires Volt)." }
end

local ACTION = "${action}"

if ACTION == "start" then
  if __g.__mcp_packetSpy and __g.__mcp_packetSpy.active then
    return { started = false, alreadyActive = true, captured = #(__g.__mcp_packetSpy.logs or {}) }
  end
  local state = { active = true, logs = {}, max = 500, preview = ${preview} }
  local function hook(packet)
    pcall(function()
      local s = __g.__mcp_packetSpy
      if not (s and s.active) then return end
      local rec = {
        size = packet.Size,
        priority = packet.Priority,
        reliability = packet.Reliability,
        orderingChannel = packet.OrderingChannel,
      }
      local okStr, str = pcall(function() return packet.AsString end)
      if okStr and type(str) == "string" then
        local n = math.min(#str, s.preview)
        local hex = {}
        for i = 1, n do hex[i] = string.format("%02x", string.byte(str, i)) end
        rec.preview = table.concat(hex)
      end
      local logs = s.logs
      logs[#logs + 1] = rec
      if #logs > s.max then table.remove(logs, 1) end
    end)
  end
  state.hook = hook
  __g.__mcp_packetSpy = state
  local ok, err = pcall(raknet.add_send_hook, hook)
  if not ok then __g.__mcp_packetSpy = nil; return { error = "add_send_hook failed: " .. tostring(err) } end
  return { started = true }
elseif ACTION == "fetch" then
  local s = __g.__mcp_packetSpy
  if not (s and s.logs) then return { error = "Packet spy is not active. Start it first.", active = false } end
  local logs, out = s.logs, {}
  for i = #logs, math.max(1, #logs - ${lim} + 1), -1 do out[#out + 1] = logs[i] end
  return { active = s.active == true, captured = #logs, packets = out }
else
  local s = __g.__mcp_packetSpy
  if not s then return { stopped = true, wasActive = false } end
  local removed = false
  if type(raknet.remove_send_hook) == "function" and s.hook then
    removed = pcall(raknet.remove_send_hook, s.hook)
  end
  s.active = false
  __g.__mcp_packetSpy = nil
  return { stopped = true, hookRemoved = removed }
end
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
