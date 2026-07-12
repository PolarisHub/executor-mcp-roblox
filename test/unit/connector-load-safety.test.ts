import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const connector = readFileSync(new URL("../../connector/connector.luau", import.meta.url), "utf8");

describe("connector load safety", () => {
  it("uses bounded eval, RPC, pubsub, and output budgets", () => {
    expect(connector).toContain("local MAX_CONCURRENT_EVALS = boundedInteger");
    expect(connector).toContain("local MAX_QUEUED_EVALS = boundedInteger");
    expect(connector).toContain("local MAX_RPC_BATCH_CALLS = boundedInteger");
    expect(connector).toContain("local MAX_PUBSUB_DISPATCH_QUEUE = 128");
    expect(connector).toContain("local OUTPUT_BUFFER_LIMIT = boundedInteger");
    expect(connector).toContain('kind = "overloaded"');
  });

  it("does not spawn an unbounded task for every websocket message", () => {
    const start = connector.indexOf("socket.OnMessage:Connect(function(raw)");
    const end = connector.indexOf("socket.OnClose:Connect", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(connector.slice(start, end)).not.toContain("task.spawn");
  });

  it("keeps a nested eval lane and chunks oversized in-script batches", () => {
    expect(connector).toContain('if job.op.priority == "nested" then return index end');
    expect(connector).toContain("first + MAX_RPC_BATCH_CALLS - 1");
    expect(connector).toContain("activeScriptParents");
  });

  it("normalizes copied HTTP/WebSocket URLs and prefers IPv4 localhost", () => {
    expect(connector).toContain('RuntimeConfig.BridgeURL or "127.0.0.1:16384"');
    expect(connector).toContain('text = text:gsub("^wss?://", ""):gsub("^https?://", "")');
    expect(connector).toContain('text = text:gsub("/bridge/?$", ""):gsub("/+$", "")');
    expect(connector).toContain('candidates[#candidates + 1] = "127.0.0.1" .. port');
    expect(connector).toContain('"executor returned no socket"');
    expect(connector).toContain('"WebSocket connection failed; tried "');
  });

  it("advertises closure, Actor, state, script-identity, and input primitives during handshake", () => {
    for (const capability of [
      '"clonefunction"',
      '"isfunctionhooked"',
      '"newlclosure"',
      '"restorefunction"',
      '"run_on_actor"',
      '"getluastate"',
      '"getactorstates"',
      '"create_comm_channel"',
      '"LuaStateProxy.new"',
      '"cloneref"',
      '"compareinstances"',
      '"getcallingscript"',
      '"getscriptclosure"',
      '"getsenv"',
      '"getfenv"',
      '"mouse1click"',
      '"keypress"',
      '"keyclick"',
      '"iswindowactive"',
    ]) {
      expect(connector).toContain(capability);
    }
  });
});
