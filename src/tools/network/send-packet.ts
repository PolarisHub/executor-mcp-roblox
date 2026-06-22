import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Send a custom outgoing RakNet packet (raknet.send). The payload is given as a
 * hex string and converted to a byte array in-client. Priority / reliability /
 * ordering channel map directly to RakNet's send parameters.
 */
export default defineTool({
  name: "send-packet",
  title: "Send a custom RakNet packet",
  description:
    "WRITES LIVE GAME STATE — transmits a raw packet. Sends a custom OUTGOING low-level packet via raknet.send " +
    "with the given payload (a hex string, converted to a byte array), priority, reliability, and ordering " +
    "channel. Requires the `raknet` library. WARNING: malformed packets or wrong " +
    "metadata can disconnect the client or break protocol behavior — only send payloads you understand.",
  category: "Network",
  mutatesState: true,
  input: z.object({
    dataHex: z
      .string()
      .describe(
        "Payload as a hex string (e.g. '01020304' or '01 02 03 04'); whitespace is ignored. Must be an even number of hex digits.",
      ),
    priority: z.number().int().describe("RakNet send priority (default 0).").optional().default(0),
    reliability: z
      .number()
      .int()
      .describe("RakNet reliability mode (default 0).")
      .optional()
      .default(0),
    orderingChannel: z
      .number()
      .int()
      .describe("Ordering channel for ordered traffic (default 0).")
      .optional()
      .default(0),
    threadContext: z.number().int().optional(),
  }),
  async execute({ dataHex, priority, reliability, orderingChannel, threadContext }, ctx) {
    const source = `
if type(raknet) ~= "table" or type(raknet.send) ~= "function" then
  return { error = "raknet.send is not available in this executor." }
end
local hex = ${q(dataHex)}:gsub("%s", "")
if #hex == 0 then return { error = "dataHex is empty." } end
if #hex % 2 ~= 0 then return { error = "dataHex must have an even number of hex digits." } end
local bytes = {}
for i = 1, #hex, 2 do
  local b = tonumber(hex:sub(i, i + 1), 16)
  if not b then return { error = "invalid hex near position " .. i } end
  bytes[#bytes + 1] = b
end
local ok, err = pcall(raknet.send, bytes, ${Math.floor(priority)}, ${Math.floor(reliability)}, ${Math.floor(orderingChannel)})
if not ok then return { error = "raknet.send failed: " .. tostring(err) } end
return { sent = true, byteCount = #bytes }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
