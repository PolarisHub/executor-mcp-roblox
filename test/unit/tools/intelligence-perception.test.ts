import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import observeWorld from "../../../src/tools/intelligence/observe-world.js";
import resolveEntity from "../../../src/tools/intelligence/resolve-entity.js";

function mockContext(returnValue: unknown): ToolContext & {
  calls: Array<{ source: string; options?: LuauOptions }>;
} {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const ctx = {
    calls,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return ctx.logger;
      },
    },
    signal: new AbortController().signal,
    client: undefined,
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return returnValue;
    },
    clients: {
      list() {
        return [];
      },
      get() {
        return undefined;
      },
      count() {
        return 0;
      },
    },
    session: {
      id: "perception-test-session" as never,
      label: "perception-test",
      selection: { kind: "auto" } as never,
      select() {},
      clear() {},
      resolve() {
        return { kind: "none" } as never;
      },
    },
  } as unknown as ToolContext & {
    calls: Array<{ source: string; options?: LuauOptions }>;
  };
  return ctx;
}

describe("intelligence perception tools", () => {
  it("publishes read-only, client-bound tools with explicit AI contracts", () => {
    expect(observeWorld.name).toBe("observe-world");
    expect(resolveEntity.name).toBe("resolve-entity");
    for (const tool of [observeWorld, resolveEntity]) {
      expect(tool.category).toBe("Intelligence");
      expect(tool.requiresClient ?? true).toBe(true);
      expect(tool.mutatesState).toBe(false);
      expect(tool.ai?.prerequisites).toContain("active-client");
      expect(tool.ai?.sideEffects).toEqual([]);
      expect(tool.ai?.failureRecovery.length).toBeGreaterThanOrEqual(3);
    }
    expect(observeWorld.ai?.phase).toBe("observe");
    expect(observeWorld.ai?.produces).toContain("semantic-entity-handles");
    expect(observeWorld.ai?.verifiesWith).toContain("resolve-entity");
    expect(resolveEntity.ai?.phase).toBe("verify");
    expect(resolveEntity.ai?.consumes).toContain("semantic-entity-handle");
  });

  it("observes all requested domains in one hard-bounded GetChildren walk", async () => {
    const decoded = {
      ok: true,
      scanned: { instances: 123 },
      returned: { entities: 17 },
      truncated: { instances: false, results: true },
      character: { status: "resolved" },
    };
    const ctx = mockContext(decoded);

    const result = await observeWorld.execute(
      {
        radius: 175,
        roots: ["workspace", "playerGui", "backpack", "character"],
        features: ["character", "camera", "gui", "nearby", "interactables", "tools"],
        maxInstances: 321,
        maxResults: 17,
        threadContext: 6,
      },
      ctx,
    );

    expect(result.data).toBe(decoded);
    expect(result.summary).toContain("Observed 17 semantic entities from 123");
    expect(result.summary).toContain("truncated");
    expect(ctx.calls).toHaveLength(1);
    const call = ctx.calls[0]!;
    expect(call.options).toEqual({ timeoutMs: 30000, threadContext: 6 });
    expect(call.source).toContain("local RADIUS = 175");
    expect(call.source).toContain("local MAX_INSTANCES = 321");
    expect(call.source).toContain("local MAX_RESULTS = 17");
    expect(call.source).toContain('local SESSION_KEY = "perception-test-session"');
    expect(call.source).toContain("instance:GetChildren()");
    expect(call.source).not.toContain("instance:GetDescendants()");
    expect(call.source).not.toContain("RenderStepped");
    expect(call.source).not.toContain("Heartbeat");

    // The fused pass covers all requested perception sources.
    expect(call.source).toContain('safeService("Workspace")');
    expect(call.source).toContain("Players.LocalPlayer");
    expect(call.source).toContain('FindFirstChildOfClass("PlayerGui")');
    expect(call.source).toContain('FindFirstChildOfClass("Backpack")');
    expect(call.source).toContain("Workspace.CurrentCamera");
    expect(call.source).toContain('isA(instance, "ClickDetector")');
    expect(call.source).toContain('isA(instance, "ProximityPrompt")');
    expect(call.source).toContain('isA(instance, "TouchTransmitter")');
    expect(call.source).toContain('isA(instance, "Tool")');
    expect(call.source).toContain("camera:WorldToViewportPoint(position)");

    // Stable handles are isolated by MCP session and preserve rediscovery evidence.
    expect(call.source).toContain("env.__mcp_world_brain");
    expect(call.source).toContain('{ __mode = "v" }');
    expect(call.source).toContain('{ __mode = "k" }');
    expect(call.source).toContain("fingerprintOf(instance, rootLabel)");
    expect(call.source).toContain('handle = "wb:" .. tostring(brain.nextId)');
    expect(call.source).toContain("expressionOf(instance)");
    expect(call.source).toContain("queueTruncated");
  });

  it("resolves a live handle first and bounds optional fingerprint rediscovery", async () => {
    const decoded = {
      ok: true,
      status: "rediscovered",
      path: "Workspace.Shop.Buy",
      class: "Part",
      confidence: 0.87,
    };
    const ctx = mockContext(decoded);

    const result = await resolveEntity.execute(
      {
        handle: "wb:12",
        rediscover: true,
        roots: ["workspace", "playerGui"],
        maxInstances: 456,
        minConfidence: 0.6,
        threadContext: 3,
      },
      ctx,
    );

    expect(result.data).toBe(decoded);
    expect(result.summary).toBe(
      "Entity wb:12 is rediscovered at Workspace.Shop.Buy at confidence 0.87.",
    );
    expect(ctx.calls).toHaveLength(1);
    const call = ctx.calls[0]!;
    expect(call.options).toEqual({ timeoutMs: 30000, threadContext: 3 });
    expect(call.source).toContain('local HANDLE = "wb:12"');
    expect(call.source).toContain('local SESSION_KEY = "perception-test-session"');
    expect(call.source).toContain("local REDISCOVER = true");
    expect(call.source).toContain("local MAX_INSTANCES = 456");
    expect(call.source).toContain("local MIN_CONFIDENCE = 0.6");
    expect(call.source).toContain("brain.refs[HANDLE]");
    expect(call.source).toContain("liveInstance(referenced)");
    expect(call.source).toContain("scoreCandidate(instance, entry.root)");
    expect(call.source).toContain("runnerUpConfidence");
    expect(call.source).toContain("adjustedConfidence");
    expect(call.source).toContain("instance:GetChildren()");
    expect(call.source).not.toContain("instance:GetDescendants()");
    expect(call.source).not.toContain("RenderStepped");
    expect(call.source).not.toContain("Heartbeat");
  });

  it("can report a stale handle without scanning when rediscovery is disabled", async () => {
    const decoded = {
      ok: false,
      status: "stale",
      path: "Workspace.OldDoor",
      class: "Part",
      confidence: 0,
    };
    const ctx = mockContext(decoded);

    const result = await resolveEntity.execute(
      {
        handle: "wb:7",
        rediscover: false,
        roots: ["workspace"],
        maxInstances: 100,
        minConfidence: 0.45,
      },
      ctx,
    );

    expect(ctx.calls[0]?.source).toContain("local REDISCOVER = false");
    expect(ctx.calls[0]?.options?.threadContext).toBeUndefined();
    expect(result.summary).toContain("Entity wb:7 is stale at Workspace.OldDoor");
  });
});
