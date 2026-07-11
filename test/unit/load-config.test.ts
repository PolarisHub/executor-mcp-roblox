import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/infrastructure/config/load-config.js";
import { ConfigError } from "../../src/domain/errors/errors.js";

describe("loadConfig bridge load budgets", () => {
  it("loads bounded multi-agent bridge tuning from the environment", () => {
    const config = loadConfig([], {
      ROBLOX_MCP_MAX_CONCURRENT_EVALS: "4",
      ROBLOX_MCP_MAX_QUEUED_EVALS: "256",
      ROBLOX_MCP_MAX_QUEUED_SOURCE_BYTES: "8388608",
      ROBLOX_MCP_RPC_BATCH_CONCURRENCY: "12",
      ROBLOX_MCP_MAX_RPC_BATCH_CALLS: "192",
      ROBLOX_MCP_MAX_CONCURRENT_RPC_FRAMES: "3",
      ROBLOX_MCP_MAX_QUEUED_RPC_FRAMES: "48",
    });

    expect(config.bridge).toMatchObject({
      maxConcurrentEvals: 4,
      maxQueuedEvals: 256,
      maxQueuedSourceBytes: 8_388_608,
      rpcBatchConcurrency: 12,
      maxRpcBatchCalls: 192,
      maxConcurrentRpcFrames: 3,
      maxQueuedRpcFrames: 48,
    });
  });

  it("rejects unsafe concurrency values instead of silently accepting them", () => {
    expect(() => loadConfig([], { ROBLOX_MCP_MAX_CONCURRENT_EVALS: "1000" })).toThrow(ConfigError);
  });
});
