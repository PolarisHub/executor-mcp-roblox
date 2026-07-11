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
});
