import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import worldDelta from "../../../src/tools/intelligence/world-delta.js";

interface CapturedCall {
  readonly source: string;
  readonly options?: LuauOptions;
}

function stubContext(canned: unknown): {
  readonly ctx: ToolContext;
  readonly calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const ctx = {
    session: { id: "world-delta-test-session" },
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return canned;
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("world-delta", () => {
  it("declares observer mutations and a rich recovery-aware AI contract", () => {
    expect(worldDelta.name).toBe("world-delta");
    expect(worldDelta.category).toBe("Intelligence");
    expect(worldDelta.requiresClient ?? true).toBe(true);
    expect(worldDelta.mutatesState).toBe(true);
    expect(worldDelta.description).toContain("WRITES LIVE CLIENT OBSERVER STATE");
    expect(worldDelta.description).toContain("never modifies gameplay Instances");
    expect(worldDelta.description).toContain("no RenderStepped");
    expect(worldDelta.ai).toMatchObject({
      phase: "observe",
      requiresCapabilities: ["getgenv"],
      verifiesWith: ["observe-world"],
    });
    expect(worldDelta.ai?.produces).toEqual(
      expect.arrayContaining([
        "event-driven-world-deltas",
        "monotonic-cursor",
        "buffer-gap-and-drop-accounting",
      ]),
    );
    expect(worldDelta.ai?.sideEffects.join(" ")).toContain("RBXScriptConnections");
    expect(worldDelta.ai?.failureRecovery.join(" ")).toContain("cursorGap");
    expect(worldDelta.ai?.failureRecovery.join(" ")).toContain("Always call stop");
  });

  it("enforces hard event, poll, TTL, target, and aggregate property bounds", () => {
    expect(worldDelta.input.parse({ action: "start" })).toMatchObject({
      action: "start",
      cursor: 0,
      limit: 100,
      maxEvents: 500,
      ttlSeconds: 300,
      throttleMs: 50,
      coalesceWindowMs: 100,
      watchedProperties: [],
    });
    expect(worldDelta.input.safeParse({ action: "start", maxEvents: 2001 }).success).toBe(false);
    expect(worldDelta.input.safeParse({ action: "start", maxEvents: 15 }).success).toBe(false);
    expect(worldDelta.input.safeParse({ action: "start", ttlSeconds: 4 }).success).toBe(false);
    expect(worldDelta.input.safeParse({ action: "start", ttlSeconds: 3601 }).success).toBe(false);
    expect(worldDelta.input.safeParse({ action: "poll", limit: 501 }).success).toBe(false);

    const properties = Array.from({ length: 13 }, (_, index) => `Property${index}`);
    const aggregate = Array.from({ length: 5 }, (_, index) => ({
      instancePath: `game.Workspace.Target${index}`,
      properties,
    }));
    expect(
      worldDelta.input.safeParse({ action: "start", watchedProperties: aggregate }).success,
    ).toBe(false);

    const tooManyTargets = Array.from({ length: 17 }, (_, index) => ({
      instancePath: `game.Workspace.Target${index}`,
      properties: ["Value"],
    }));
    expect(
      worldDelta.input.safeParse({ action: "start", watchedProperties: tooManyTargets }).success,
    ).toBe(false);
  });

  it("installs every required event source without frame loops or world scans", async () => {
    const canned = {
      observerId: "wd:9",
      started: true,
      active: true,
      connections: 18,
      nextCursor: 0,
    };
    const { ctx, calls } = stubContext(canned);
    const input = worldDelta.input.parse({
      action: "start",
      maxEvents: 321,
      ttlSeconds: 45,
      throttleMs: 75,
      coalesceWindowMs: 125,
      filters: {
        sources: ["workspace", "playerGui", "character", "camera", "backpack", "watched"],
        classes: ["Part", "Tool"],
        nameContains: "Door",
        pathContains: "Workspace.Shop",
      },
      cameraProperties: ["CFrame", "FieldOfView"],
      watchedProperties: [
        { instancePath: "game.Workspace.Door", properties: ["Transparency", "CanCollide"] },
      ],
      threadContext: 7,
    });

    const result = await worldDelta.execute(input, ctx);

    expect(result.data).toBe(canned);
    expect(result.summary).toContain("wd:9 is observing live world deltas through 18 connections");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ threadContext: 7, timeoutMs: 20000 });
    const source = calls[0]?.source ?? "";
    expect(source).toContain('local SESSION_KEY = "world-delta-test-session"');
    expect(source).toContain("local MAX_EVENTS = 321");
    expect(source).toContain("local TTL_SECONDS = 45");
    expect(source).toContain("local THROTTLE_MS = 75");
    expect(source).toContain("local COALESCE_WINDOW_MS = 125");
    expect(source).toContain('["Part"] = true');
    expect(source).toContain('local NAME_CONTAINS = "door"');
    expect(source).toContain('local PATH_CONTAINS = "workspace.shop"');
    expect(source).toContain(
      '{ expression = "game.Workspace.Door", properties = { "Transparency", "CanCollide" } }',
    );

    expect(source).toContain("Workspace.DescendantAdded");
    expect(source).toContain("Workspace.DescendantRemoving");
    expect(source).toContain("playerGui.DescendantAdded");
    expect(source).toContain("playerGui.DescendantRemoving");
    expect(source).toContain("LocalPlayer.CharacterAdded");
    expect(source).toContain("LocalPlayer.CharacterRemoving");
    expect(source).toContain("character.DescendantAdded");
    expect(source).toContain("character.DescendantRemoving");
    expect(source).toContain("Workspace.CurrentCamera");
    expect(source).toContain('propertySignal(Workspace, "CurrentCamera")');
    expect(source).toContain("instance:GetPropertyChangedSignal(property)");
    expect(source).toContain("backpack.DescendantAdded");
    expect(source).toContain("backpack.DescendantRemoving");
    expect(source).toContain('FindFirstChildOfClass("PlayerGui")');
    expect(source).toContain('FindFirstChildOfClass("Backpack")');
    expect(source).toContain('emit("watched", "watched-property-changed"');

    expect(source).not.toContain("RenderStepped");
    expect(source).not.toContain("Heartbeat");
    expect(source).not.toContain("GetDescendants");
    expect(source).not.toContain("while true");
  });

  it("uses a versioned bounded registry, ring buffer, coalescing, and monotonic cursors", async () => {
    const { ctx, calls } = stubContext({ observerId: "wd:1", active: true, connections: 4 });
    await worldDelta.execute(worldDelta.input.parse({ action: "start" }), ctx);
    const source = calls[0]?.source ?? "";

    expect(source).toContain('local REGISTRY_KEY = "__mcp_world_delta"');
    expect(source).toContain("local REGISTRY_VERSION = 1");
    expect(source).toContain("local HARD_MAX_OBSERVERS = 8");
    expect(source).toContain("local HARD_MAX_SESSION_OBSERVERS = 4");
    expect(source).toContain("local HARD_MAX_TOMBSTONES = 16");
    expect(source).toContain("local HARD_MAX_EVENTS = 2000");
    expect(source).toContain("local HARD_MAX_WATCH_PROPERTIES = 64");
    expect(source).toContain("Refusing to overwrite unknown or corrupt");
    expect(source).toContain('local observerId = "wd:" .. tostring(registry.nextObserverId)');
    expect(source).toContain("state.cursor = state.cursor + 1");
    expect(source).toContain("while state.eventCount > state.maxEvents do");
    expect(source).toContain("state.droppedEvents = state.droppedEvents + 1");
    expect(source).toContain("state.droppedThrough = math.max");
    expect(source).toContain("state.coalescedEvents = state.coalescedEvents + 1");
    expect(source).toContain("state.throttledEvents = state.throttledEvents + 1");
    expect(source).toContain("event.repeatCount = event.repeatCount + 1");
    expect(source).toContain("compactEvents()");
  });

  it("polls after a cursor with pagination and explicit buffer-gap accounting", async () => {
    const canned = {
      observerId: "wd:4",
      active: true,
      events: [{ cursor: 43 }],
      nextCursor: 43,
      latestCursor: 50,
      hasMore: true,
      cursorGap: true,
      droppedSinceCursor: 10,
    };
    const { ctx, calls } = stubContext(canned);
    const result = await worldDelta.execute(
      worldDelta.input.parse({
        action: "poll",
        observerId: "wd:4",
        cursor: 42,
        limit: 7,
      }),
      ctx,
    );
    const source = calls[0]?.source ?? "";

    expect(source).toContain('local ACTION = "poll"');
    expect(source).toContain('local REQUESTED_ID = "wd:4"');
    expect(source).toContain("local REQUEST_CURSOR = 42");
    expect(source).toContain("local POLL_LIMIT = 7");
    expect(source).toContain("if REQUEST_CURSOR > state.cursor then");
    expect(source).toContain("local cursorGap = effectiveCursor < state.droppedThrough");
    expect(source).toContain("event.cursor > effectiveCursor");
    expect(source).toContain("events[#events + 1] = publicEvent(event)");
    expect(source).toContain("nextCursor = event.cursor");
    expect(source).toContain("hasMore = true");
    expect(source).toContain("droppedSinceCursor = state.droppedThrough - effectiveCursor");
    expect(result.summary).toContain("nextCursor=43");
    expect(result.summary).toContain("buffer gap was reported");
  });

  it("shares complete disconnect cleanup between stop and mandatory TTL expiry", async () => {
    const canned = {
      observerId: "wd:6",
      stopped: true,
      disconnectedConnections: 12,
      latestCursor: 18,
    };
    const { ctx, calls } = stubContext(canned);
    const result = await worldDelta.execute(
      worldDelta.input.parse({ action: "stop", observerId: "wd:6" }),
      ctx,
    );
    const source = calls[0]?.source ?? "";

    expect(source).toContain('local ACTION = "stop"');
    expect(source).toContain("for groupName in pairs(state.groups) do");
    expect(source).toContain("connection:Disconnect()");
    expect(source).toContain("pcall(task.cancel, state.expiryThread)");
    expect(source).toContain('retireState(state, "stopped")');
    expect(source).toContain("registry.observers[state.id] = nil");
    expect(source).toContain("state.coalesce = {}");
    expect(source).toContain("state.lastEmitted = {}");
    expect(source).toContain("task.delay(TTL_SECONDS");
    expect(source).toContain('retireState(state, "expired")');
    expect(source).toContain("if current == state and state.active == true");
    expect(result.summary).toContain("disconnected 12 observer connection(s)");
  });

  it("rejects caller-selected start ids before installing any connections", async () => {
    const { ctx, calls } = stubContext({});
    const result = await worldDelta.execute(
      worldDelta.input.parse({ action: "start", observerId: "wd:overwrite" }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.summary).toContain("omit observerId");
    expect(calls).toHaveLength(0);
  });
});
