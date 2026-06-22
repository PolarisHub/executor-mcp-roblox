import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Block outgoing RakNet packets that match criteria, via a send hook that calls
 * RakNetPacket:Block(). Match by minimum size and/or a hex substring in the
 * payload. Stateful start/stop.
 */
export default defineTool({
  name: "block-packets",
  title: "Block outgoing RakNet packets by criteria (Volt)",
  description:
    "WRITES LIVE GAME STATE — installs a RakNet send hook that DROPS matching outgoing packets. A packet is " +
    "blocked when its Size >= minSize (if set) and/or its payload contains containsHex (if set); with neither " +
    "criterion every outgoing packet is blocked (dangerous). action='start' installs the hook, 'stop' removes " +
    "it. Requires a Volt-class executor with the `raknet` library. WARNING: blocking outgoing traffic can break " +
    "the game, freeze replication, or disconnect the client — use narrow criteria and stop promptly.",
  category: "Network",
  mutatesState: true,
  input: z.object({
    action: z
      .enum(["start", "stop"])
      .describe("'start' installs the blocking hook; 'stop' removes it."),
    minSize: z
      .number()
      .int()
      .describe("Block packets whose Size is at least this many bytes. Omit to not filter by size.")
      .optional(),
    containsHex: z
      .string()
      .describe(
        "Block packets whose payload contains this hex byte sequence (e.g. '1a2b'). Omit to not filter by content.",
      )
      .optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, minSize, containsHex, threadContext }, ctx) {
    const minSizeExpr = minSize === undefined ? "nil" : String(Math.floor(minSize));
    const containsExpr =
      containsHex === undefined ? "nil" : q(containsHex.replace(/\s+/g, "").toLowerCase());
    const source = `
if type(getgenv) ~= "function" then return { error = "getgenv is not available; cannot maintain the packet blocker." } end
local __g = getgenv()
if type(raknet) ~= "table" or type(raknet.add_send_hook) ~= "function" then
  return { error = "raknet.add_send_hook is not available in this executor (requires Volt)." }
end

if "${action}" == "start" then
  if __g.__mcp_packetBlock and __g.__mcp_packetBlock.active then
    return { started = false, alreadyActive = true }
  end
  local state = { active = true, minSize = ${minSizeExpr}, contains = ${containsExpr}, blocked = 0 }
  local function toHex(s)
    local hex = {}
    for i = 1, #s do hex[i] = string.format("%02x", string.byte(s, i)) end
    return table.concat(hex)
  end
  local function hook(packet)
    pcall(function()
      local s = __g.__mcp_packetBlock
      if not (s and s.active) then return end
      local match = true
      if s.minSize ~= nil then
        if not (packet.Size and packet.Size >= s.minSize) then match = false end
      end
      if match and s.contains ~= nil then
        local okStr, str = pcall(function() return packet.AsString end)
        if okStr and type(str) == "string" then
          if not string.find(toHex(str), s.contains, 1, true) then match = false end
        else
          match = false
        end
      end
      if match then
        s.blocked = s.blocked + 1
        packet:Block()
      end
    end)
  end
  state.hook = hook
  __g.__mcp_packetBlock = state
  local ok, err = pcall(raknet.add_send_hook, hook)
  if not ok then __g.__mcp_packetBlock = nil; return { error = "add_send_hook failed: " .. tostring(err) } end
  return { started = true, minSize = ${minSizeExpr}, contains = ${containsExpr} }
else
  local s = __g.__mcp_packetBlock
  if not s then return { stopped = true, wasActive = false } end
  local removed = false
  if type(raknet.remove_send_hook) == "function" and s.hook then
    removed = pcall(raknet.remove_send_hook, s.hook)
  end
  s.active = false
  local blocked = s.blocked or 0
  __g.__mcp_packetBlock = nil
  return { stopped = true, hookRemoved = removed, totalBlocked = blocked }
end
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
