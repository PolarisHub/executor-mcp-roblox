import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import getPlayers from "../../../src/tools/session/get-players.js";
import getLocalPlayerInfo from "../../../src/tools/session/get-local-player-info.js";
import getPlaceDetails from "../../../src/tools/session/get-place-details.js";
import { sessionTools } from "../../../src/tools/session/index.js";

/** Records every runLuau call and returns a canned decoded value. */
function mockContext(returnValue: unknown = { ok: true }): ToolContext & {
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
      id: "test" as never,
      label: "test",
      selection: { kind: "auto" } as never,
      select() {},
      clear() {},
      resolve() {
        return { kind: "none" } as never;
      },
    },
  } as unknown as ToolContext & { calls: Array<{ source: string; options?: LuauOptions }> };
  return ctx;
}

describe("Session & Client tools", () => {
  it("registers all 7 tools in the category index, each tagged correctly", () => {
    expect(sessionTools).toHaveLength(7);
    for (const tool of sessionTools) {
      expect(tool.category).toBe("Session & Client");
      // Every Session & Client tool is read-only.
      expect(tool.mutatesState ?? false).toBe(false);
    }
    const names = sessionTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
    expect(names).toEqual([
      "list-clients",
      "select-client",
      "clear-selection",
      "get-active-client",
      "get-players",
      "get-local-player-info",
      "get-place-details",
    ]);
  });

  it("the three ported reads are client-bound (requiresClient default true)", () => {
    for (const tool of [getPlayers, getLocalPlayerInfo, getPlaceDetails]) {
      expect(tool.requiresClient ?? true).toBe(true);
    }
  });

  describe("get-players", () => {
    it("runs the roster scan with the 20s timeout and drops setthreadidentity", async () => {
      const decoded = { ok: true, count: 2, localPlayer: "Me", players: [] };
      const ctx = mockContext(decoded);

      const result = await getPlayers.execute({}, ctx);

      expect(result.data).toBe(decoded);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(20000);
      // No threadContext supplied -> not forwarded (gateway default applies).
      expect(options?.threadContext).toBeUndefined();
      // The legacy setthreadidentity prefix must be gone.
      expect(source).not.toContain("setthreadidentity");
      // Body preserved verbatim: enumerates the live roster.
      expect(source).toContain('game:GetService("Players")');
      expect(source).toContain("Players:GetPlayers()");
    });

    it("forwards threadContext through the runLuau options when supplied", async () => {
      const ctx = mockContext();
      await getPlayers.execute({ threadContext: 5 }, ctx);
      expect(ctx.calls[0]?.options?.threadContext).toBe(5);
    });
  });

  describe("get-local-player-info", () => {
    it("snapshots player + character with the 20s timeout, no setthreadidentity", async () => {
      const decoded = { ok: true, player: { Name: "Me" }, character: null };
      const ctx = mockContext(decoded);

      const result = await getLocalPlayerInfo.execute({ threadContext: 2 }, ctx);

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBe(2);
      expect(source).not.toContain("setthreadidentity");
      // Body preserved verbatim: reads LocalPlayer and the Humanoid.
      expect(source).toContain("Players.LocalPlayer");
      expect(source).toContain('FindFirstChildOfClass("Humanoid")');
      expect(source).toContain("HumanoidRootPart");
    });
  });

  describe("get-place-details", () => {
    it("reads place/server identity with the 20s timeout, no setthreadidentity", async () => {
      const decoded = { ok: true, PlaceId: 123, JobId: "abc" };
      const ctx = mockContext(decoded);

      const result = await getPlaceDetails.execute({}, ctx);

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBeUndefined();
      expect(source).not.toContain("setthreadidentity");
      // Body preserved verbatim: reads the place/server identifiers.
      expect(source).toContain("game.PlaceId");
      expect(source).toContain("game.JobId");
      expect(source).toContain("StreamingEnabled");
    });
  });
});
