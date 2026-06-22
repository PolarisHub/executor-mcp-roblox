import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import wsConnect from "../../../src/tools/network/ws-connect.js";
import wsSend from "../../../src/tools/network/ws-send.js";
import wsReceive from "../../../src/tools/network/ws-receive.js";
import wsClose from "../../../src/tools/network/ws-close.js";
import wsList from "../../../src/tools/network/ws-list.js";

/**
 * Minimal ToolContext stub: records each runLuau source + options and returns a
 * canned decoded value. We assert only on the Luau the tool builds and the { data }
 * it passes through — no socket, no game.
 */
function stubContext(canned: unknown): {
  ctx: ToolContext;
  calls: Array<{ source: string; options?: LuauOptions }>;
} {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const ctx = {
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return canned;
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("WebSocket tools", () => {
  describe("ws-connect", () => {
    it("is a mutator that guards WebSocket.connect and wires OnMessage/OnClose", async () => {
      expect(wsConnect.mutatesState).toBe(true);
      const canned = { id: 1, url: "ws://127.0.0.1:8080" };
      const { ctx, calls } = stubContext(canned);
      const input = wsConnect.input.parse({ url: "ws://127.0.0.1:8080", threadContext: 7 });

      const result = await wsConnect.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      expect(source).toContain(
        'if type(WebSocket) ~= "table" or type(WebSocket.connect) ~= "function" then',
      );
      expect(source).toContain(
        'return { error = "WebSocket.connect is not available in this executor." }',
      );
      expect(source).toContain('pcall(WebSocket.connect, "ws://127.0.0.1:8080")');
      expect(source).toContain("__g.__mcp_ws");
      expect(source).toContain("__g.__mcp_ws_counter");
      expect(source).toContain("socket.OnMessage:Connect");
      expect(source).toContain("socket.OnClose:Connect");
      expect(source).toContain("e.max"); // capped (200) ring buffer
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBe(7);
    });
  });

  describe("ws-send", () => {
    it("is a mutator that looks up the entry, guards open, and calls :Send", async () => {
      expect(wsSend.mutatesState).toBe(true);
      const canned = { id: 3, sent: true };
      const { ctx, calls } = stubContext(canned);
      const input = wsSend.input.parse({ id: 3, message: 'hello "ws"' });

      const result = await wsSend.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      expect(source).toContain("local id = 3");
      expect(source).toContain("__g.__mcp_ws[id]");
      expect(source).toContain("if not entry.open then");
      // message funnels through q() (embedded quotes escaped).
      expect(source).toContain(':Send("hello \\"ws\\"")');
      expect(options?.timeoutMs).toBe(20000);
    });
  });

  describe("ws-receive", () => {
    it("is read-only and returns newest-first frames capped at limit", async () => {
      expect(wsReceive.mutatesState).toBeFalsy();
      const canned = { id: 2, open: true, messageCount: 0, messages: [] };
      const { ctx, calls } = stubContext(canned);
      const input = wsReceive.input.parse({ id: 2, limit: 50, clear: true });

      const result = await wsReceive.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source } = calls[0]!;
      expect(source).toContain("local id = 2");
      expect(source).toContain("entry.messages");
      // limit spliced into the newest-first walk.
      expect(source).toContain("total - 50 + 1");
      // clear=true empties the ring after the snapshot.
      expect(source).toContain("entry.messages = {}");
      expect(source).toContain("messageCount = total");
    });

    it("does not clear the ring when clear is false (default)", async () => {
      const { ctx, calls } = stubContext({});
      const input = wsReceive.input.parse({ id: 5 });
      await wsReceive.execute(input, ctx);
      const { source } = calls[0]!;
      // The clear branch condition is `if false then`, so the ring is left intact.
      expect(source).toContain("if false then");
    });
  });

  describe("ws-close", () => {
    it("is a mutator that calls :Close and drops the registry slot", async () => {
      expect(wsClose.mutatesState).toBe(true);
      const { ctx, calls } = stubContext({ id: 1, closed: true });
      const input = wsClose.input.parse({ id: 1 });
      await wsClose.execute(input, ctx);
      const { source } = calls[0]!;
      expect(source).toContain("entry.socket:Close()");
      expect(source).toContain("__g.__mcp_ws[id] = nil");
    });
  });

  describe("ws-list", () => {
    it("is read-only and enumerates the registry", async () => {
      expect(wsList.mutatesState).toBeFalsy();
      const canned = { count: 0, sockets: [] };
      const { ctx, calls } = stubContext(canned);
      const input = wsList.input.parse({});
      const result = await wsList.execute(input, ctx);
      expect(result).toEqual({ data: canned });
      const { source } = calls[0]!;
      expect(source).toContain("for id, entry in pairs(reg) do");
      expect(source).toContain("messageCount = #(entry.messages or {})");
    });
  });
});
