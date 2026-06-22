import type { Tool } from "../../application/tool/tool.js";

import packetSpy from "./packet-spy.js";
import sendPacket from "./send-packet.js";
import blockPackets from "./block-packets.js";
import httpRequest from "./http-request.js";
import wsConnect from "./ws-connect.js";
import wsSend from "./ws-send.js";
import wsReceive from "./ws-receive.js";
import wsClose from "./ws-close.js";
import wsList from "./ws-list.js";

/**
 * Low-level RakNet packet tools, the outbound HTTP request tool, and the WebSocket
 * tools (ws-connect/send/receive/close/list) — all Volt/sUNC-only.
 */
export const networkTools: Tool[] = [
  packetSpy,
  sendPacket,
  blockPackets,
  httpRequest,
  wsConnect,
  wsSend,
  wsReceive,
  wsClose,
  wsList,
];
