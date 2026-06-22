import { describe, expect, it } from "vitest";
import type { ToolContext } from "../../../src/application/tool/tool.js";
import { networkTools } from "../../../src/tools/network/index.js";
import packetSpy from "../../../src/tools/network/packet-spy.js";
import sendPacket from "../../../src/tools/network/send-packet.js";
import blockPackets from "../../../src/tools/network/block-packets.js";
import httpRequest from "../../../src/tools/network/http-request.js";

interface Captured {
  source: string;
  options?: { threadContext?: number; timeoutMs?: number };
}

function stubContext(canned: unknown): { ctx: ToolContext; calls: Captured[] } {
  const calls: Captured[] = [];
  const ctx = {
    runLuau: async (source: string, options?: Captured["options"]) => {
      calls.push({ source, options });
      return canned;
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("network (RakNet) tools", () => {
  it("exports 9 tools, all in the Network category, with the WebSocket tools added", () => {
    expect(networkTools).toHaveLength(9);
    expect(new Set(networkTools.map((t) => t.name)).size).toBe(9);
    expect(networkTools.map((t) => t.name)).toContain("http-request");
    for (const name of ["ws-connect", "ws-send", "ws-receive", "ws-close", "ws-list"]) {
      expect(networkTools.map((t) => t.name)).toContain(name);
    }
    for (const tool of networkTools) {
      expect(tool.category).toBe("Network");
    }
    // ws-receive and ws-list are read-only; everything else mutates live game state.
    const mutating = networkTools
      .filter((t) => t.mutatesState === true)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual(
      [
        "block-packets",
        "http-request",
        "packet-spy",
        "send-packet",
        "ws-close",
        "ws-connect",
        "ws-send",
      ].sort(),
    );
  });

  it("packet-spy installs a raknet send hook on start and passes data through", async () => {
    const { ctx, calls } = stubContext({ started: true });
    const input = packetSpy.input.parse({ action: "start" });
    const result = await packetSpy.execute(input, ctx);

    expect(result.data).toEqual({ started: true });
    expect(calls[0]?.source).toContain("raknet.add_send_hook");
    expect(calls[0]?.options?.timeoutMs).toBe(20000);
  });

  it("send-packet parses hex and calls raknet.send with the metadata", async () => {
    const { ctx, calls } = stubContext({ sent: true, byteCount: 4 });
    const input = sendPacket.input.parse({ dataHex: "01 02 03 04", priority: 1 });
    const result = await sendPacket.execute(input, ctx);

    expect(result.data).toEqual({ sent: true, byteCount: 4 });
    const src = calls[0]?.source ?? "";
    expect(src).toContain("raknet.send");
    expect(src).toContain("tonumber"); // hex -> byte conversion
    expect(src).toContain(", 1, 0, 0)"); // priority=1, reliability/channel default 0
  });

  it("block-packets installs a blocking hook and inlines the criteria", async () => {
    const { ctx, calls } = stubContext({ started: true });
    const input = blockPackets.input.parse({ action: "start", minSize: 512, containsHex: "1A2B" });
    await blockPackets.execute(input, ctx);

    const src = calls[0]?.source ?? "";
    expect(src).toContain("packet:Block()");
    expect(src).toContain("512");
    expect(src).toContain("1a2b"); // lowercased hex criterion
  });

  it("http-request builds a request() options table and passes data through", async () => {
    const { ctx, calls } = stubContext({ statusCode: 200, success: true, body: "ok" });
    const input = httpRequest.input.parse({
      url: "https://api.example.com/x",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    const result = await httpRequest.execute(input, ctx);

    expect(result.data).toEqual({ statusCode: 200, success: true, body: "ok" });
    const src = calls[0]?.source ?? "";
    expect(src).toContain('Url = "https://api.example.com/x"');
    expect(src).toContain('Method = "POST"');
    expect(src).toContain("Content-Type");
    expect(src).toContain("pcall(fn, opts)");
    expect(calls[0]?.options?.timeoutMs).toBe(30000);
  });
});
