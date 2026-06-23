import { describe, expect, it } from "vitest";
import type { RobloxClient } from "../../../src/domain/client/client.js";
import type { SelectionResolution } from "../../../src/domain/client/selection.js";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import testCapabilities from "../../../src/tools/diagnostics/test-capabilities.js";
import getInstanceCounts from "../../../src/tools/diagnostics/get-instance-counts.js";
import bridgeStatus from "../../../src/tools/diagnostics/bridge-status.js";
import { diagnosticsTools } from "../../../src/tools/diagnostics/index.js";

function makeClient(overrides: Partial<RobloxClient> = {}): RobloxClient {
  return {
    id: "client-1" as never,
    userId: 100 as never,
    username: "Builderman",
    displayName: "Builderman",
    placeId: 1818,
    jobId: "job-1",
    executor: "Synapse",
    capabilities: [],
    connectedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Records every runLuau call and returns a canned decoded value; clients/session injectable. */
function mockContext(
  opts: {
    returnValue?: unknown;
    clients?: readonly RobloxClient[];
    resolution?: SelectionResolution;
  } = {},
): ToolContext & { calls: Array<{ source: string; options?: LuauOptions }> } {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const clients = opts.clients ?? [];
  const resolution: SelectionResolution = opts.resolution ?? {
    status: "none",
    reason: "no-clients",
  };
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
      return opts.returnValue ?? { ok: true };
    },
    clients: {
      list() {
        return clients;
      },
      get() {
        return undefined;
      },
    },
    session: {
      id: "session-abc" as never,
      label: "Session A",
      selection: { clientId: "client-1" } as never,
      select() {},
      clear() {},
      resolve() {
        return resolution;
      },
    },
  } as unknown as ToolContext & { calls: Array<{ source: string; options?: LuauOptions }> };
  return ctx;
}

describe("Diagnostics tools", () => {
  it("registers all 12 tools in the category index, each tagged Diagnostics", () => {
    expect(diagnosticsTools).toHaveLength(12);
    for (const tool of diagnosticsTools) {
      expect(tool.category).toBe("Diagnostics");
    }
    // Every Diagnostics tool is read-only EXCEPT session-replay, which can
    // re-issue recorded calls when dryRun:false.
    for (const tool of diagnosticsTools) {
      if (tool.name === "session-replay") {
        expect(tool.mutatesState).toBe(true);
      } else {
        expect(tool.mutatesState ?? false).toBe(false);
      }
    }
    const names = diagnosticsTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
    expect(names).toContain("bridge-status");
    expect(diagnosticsTools.find((t) => t.name === "bridge-status")?.requiresClient).toBe(false);
    // Session-management tools are also client-less; they read server-side
    // state (~/.executor-mcp/sessions/) rather than the game.
    for (const n of ["session-list", "session-show", "session-replay"]) {
      expect(diagnosticsTools.find((t) => t.name === n)?.requiresClient).toBe(false);
    }
  });

  describe("test-capabilities", () => {
    it("probes the curated name list, drops setthreadidentity, and carries the 20s timeout", async () => {
      const decoded = {
        total: 44,
        availableCount: 40,
        missingCount: 4,
        available: [],
        missing: [],
      };
      const ctx = mockContext({ returnValue: decoded });

      const result = await testCapabilities.execute({}, ctx);

      expect(result.data).toBe(decoded);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBeUndefined();
      // The legacy setthreadidentity prefix must be gone.
      expect(source).not.toContain("setthreadidentity(");
      // The probe list and resolver are inlined verbatim.
      expect(source).toContain('"getgc"');
      expect(source).toContain('"debug.getinfo"');
      expect(source).toContain("local function __resolve(name)");
    });

    it("forwards threadContext through the runLuau options when supplied", async () => {
      const ctx = mockContext();
      await testCapabilities.execute({ threadContext: 7 }, ctx);
      expect(ctx.calls[0]?.options?.threadContext).toBe(7);
    });
  });

  describe("get-instance-counts (descendant census)", () => {
    it("clamps + inlines topN/maxScan and uses the 45s census timeout", async () => {
      const decoded = {
        totalInstances: 5,
        scanned: 5,
        truncated: false,
        distinctClasses: 2,
        topClasses: [],
      };
      const ctx = mockContext({ returnValue: decoded });

      const result = await getInstanceCounts.execute({ topN: 25, maxScan: 200000 }, ctx);

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      // GC/descendant census gets the long budget.
      expect(options?.timeoutMs).toBe(45000);
      expect(source).not.toContain("setthreadidentity(");
      expect(source).toContain("game:GetDescendants()");
      // The maxScan cap is interpolated into the loop guard.
      expect(source).toContain("if scanned > 200000 then truncated = true");
      // topN is interpolated into the slice.
      expect(source).toContain("math.min(#arr, 25)");
    });

    it("clamps an out-of-range maxScan into the allowed bounds before interpolation", async () => {
      const ctx = mockContext();
      await getInstanceCounts.execute({ topN: 25, maxScan: 5 }, ctx);
      // 5 is below the 1000 floor -> clamped to 1000.
      expect(ctx.calls[0]?.source).toContain("if scanned > 1000 then");
    });
  });

  describe("bridge-status (client-less, no runLuau)", () => {
    it("reports session, the resolved active client, and the connected client roster without running Luau", async () => {
      const client = makeClient();
      const ctx = mockContext({
        clients: [client],
        resolution: { status: "resolved", client },
      });

      const result = await bridgeStatus.execute({}, ctx);

      // Never touches a game.
      expect(ctx.calls).toHaveLength(0);

      const data = result.data as {
        session: { id: string; label: string; selection: unknown };
        active: { status: string; client?: { clientId: string } };
        clients: Array<{
          clientId: string;
          username: string | null;
          userId: number | null;
          placeId: number | null;
          executor: string | null;
        }>;
      };

      expect(data.session.id).toBe("session-abc");
      expect(data.session.label).toBe("Session A");
      expect(data.session.selection).toEqual({ clientId: "client-1" });

      expect(data.active.status).toBe("resolved");
      expect(data.active.client?.clientId).toBe("client-1");

      expect(data.clients).toHaveLength(1);
      expect(data.clients[0]).toEqual({
        clientId: "client-1",
        username: "Builderman",
        userId: 100,
        placeId: 1818,
        executor: "Synapse",
      });

      expect(result.summary).toContain("1 client(s) connected");
    });

    it("summarizes the empty case when no clients are connected", async () => {
      const ctx = mockContext({
        clients: [],
        resolution: { status: "none", reason: "no-clients" },
      });
      const result = await bridgeStatus.execute({}, ctx);
      expect((result.data as { clients: unknown[] }).clients).toHaveLength(0);
      expect(result.summary).toContain("no Roblox clients connected");
    });
  });
});
