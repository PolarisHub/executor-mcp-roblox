import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { Logger } from "../../application/ports/logger.js";
import type { DashboardEventBus, DashboardEvent } from "./dashboard-events.js";

/**
 * `/ws/dashboard` push channel. Every connected dashboard tab subscribes to the
 * shared {@link DashboardEventBus} and receives JSON frames as state changes:
 *
 *   { type: "output",        entries: [...] }
 *   { type: "activity",      record: {...}  }
 *   { type: "client-change", action, clientId }
 *
 * Output is the chattiest channel — we coalesce per-tick so a flood of game
 * prints can't stall a slow tab.
 */
export class DashboardWebSocketServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly logger: Logger;
  private readonly bus: DashboardEventBus;
  private readonly expectedToken: string | null;

  constructor(deps: { logger: Logger; bus: DashboardEventBus; expectedToken?: string | null }) {
    this.logger = deps.logger.child({ component: "dashboard-ws" });
    this.bus = deps.bus;
    this.expectedToken = deps.expectedToken ?? null;

    this.wss.on("connection", (socket) => {
      const unsubscribe = this.bus.subscribe((event) => {
        if (socket.readyState !== socket.OPEN) return;
        try {
          socket.send(JSON.stringify(event satisfies DashboardEvent));
        } catch {
          // Send can fail if the socket is mid-close; nothing actionable.
        }
      });
      socket.on("close", unsubscribe);
      socket.on("error", () => unsubscribe());
    });

    this.wss.on("error", (err: Error) => {
      this.logger.warn({ err: err.message }, "dashboard ws error");
    });
  }

  /** Called by the bridge's HTTP upgrade router for `/ws/dashboard`. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.expectedToken && !this.authorize(request)) {
      // Reject the upgrade with 401 before completing the websocket handshake.
      try {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      } finally {
        socket.destroy();
      }
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit("connection", ws, request);
    });
  }

  private authorize(request: IncomingMessage): boolean {
    const cookie = request.headers.cookie ?? "";
    const m = /(?:^|;\s*)executor-mcp-token=([^;]+)/.exec(cookie);
    if (m && decodeURIComponent(m[1]!) === this.expectedToken) return true;
    const header = request.headers["x-executor-mcp-token"];
    if (typeof header === "string" && header === this.expectedToken) return true;
    return false;
  }
}
