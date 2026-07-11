import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import diffInstanceSnapshot from "../../../src/tools/inspection/diff-instance-snapshot.js";
import getConnectorDiagnostics from "../../../src/tools/diagnostics/get-connector-diagnostics.js";

/**
 * Minimal mock ToolContext: records every runLuau (source + options) and returns
 * a canned decoded value, so a tool can be exercised with no socket and no game.
 */
function mockContext(
  returnValue: unknown = { ok: true },
): ToolContext & { calls: Array<{ source: string; options?: LuauOptions }> } {
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
    },
    session: {
      id: "session-tail" as never,
      label: "Tail",
      selection: {} as never,
      select() {},
      clear() {},
      resolve() {
        return { status: "none", reason: "no-clients" } as never;
      },
    },
  } as unknown as ToolContext & { calls: Array<{ source: string; options?: LuauOptions }> };
  return ctx;
}

describe("parity tail tools", () => {
  describe("diff-instance-snapshot", () => {
    it("is a read-only Inspection tool", () => {
      expect(diffInstanceSnapshot.name).toBe("diff-instance-snapshot");
      expect(diffInstanceSnapshot.category).toBe("Inspection");
      expect(diffInstanceSnapshot.mutatesState ?? false).toBe(false);
    });

    it("passes the decoded value straight through as { data } and carries the 45s timeout", async () => {
      const decoded = { action: "snapshot", name: "default", captured: 12, truncated: false };
      const ctx = mockContext(decoded);

      const result = await diffInstanceSnapshot.execute(
        { action: "snapshot", root: "game.Workspace", name: "default", maxInstances: 4000 },
        ctx,
      );

      expect(result.data).toBe(decoded);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(45000);
      // Legacy setthreadidentity prefix must be gone.
      expect(source).not.toContain("setthreadidentity(");
      // Snapshot branch and the client-side store key are inlined verbatim.
      expect(source).toContain('action = "snapshot"');
      expect(source).toContain("env.__mcp_snapshots");
      // maxInstances is clamped + interpolated into the walk guard.
      expect(source).toContain("if count >= 4000 then");
    });

    it("selects the compare branch and clamps an out-of-range maxInstances", async () => {
      const ctx = mockContext();
      await diffInstanceSnapshot.execute(
        { action: "compare", root: "game.Workspace", name: "run-1", maxInstances: 999999 },
        ctx,
      );
      const source = ctx.calls[0]!.source;
      // compare-only fragment present.
      expect(source).toContain('action = "compare"');
      expect(source).toContain("re-walk now and diff against the stored baseline");
      // 999999 is above the 50000 ceiling -> clamped.
      expect(source).toContain("if count >= 50000 then");
    });

    it("forwards threadContext through the runLuau options when supplied", async () => {
      const ctx = mockContext();
      await diffInstanceSnapshot.execute(
        {
          action: "snapshot",
          root: "game.Workspace",
          name: "default",
          maxInstances: 4000,
          threadContext: 3,
        },
        ctx,
      );
      expect(ctx.calls[0]?.options?.threadContext).toBe(3);
    });
  });

  describe("get-connector-diagnostics", () => {
    it("is a client-bound Diagnostics tool", () => {
      expect(getConnectorDiagnostics.name).toBe("get-connector-diagnostics");
      expect(getConnectorDiagnostics.category).toBe("Diagnostics");
      expect(getConnectorDiagnostics.mutatesState ?? false).toBe(false);
      // requiresClient defaults to true (never set false).
      expect(getConnectorDiagnostics.requiresClient ?? true).toBe(true);
    });

    it("passes the decoded self-report straight through as { data } with a 20s timeout", async () => {
      const decoded = {
        threadIdentity: 7,
        executor: { name: "Synapse", version: "1.0" },
        hasWebSocket: true,
        capabilities: { getgc: true },
      };
      const ctx = mockContext(decoded);

      const result = await getConnectorDiagnostics.execute({}, ctx);

      expect(result.data).toBe(decoded);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBeUndefined();
      // Self-contained Luau report: no legacy connector message type, no setthreadidentity.
      expect(source).not.toContain("setthreadidentity(");
      expect(source).not.toContain("get-connector-diagnostics");
      // The self-report fragments are present.
      expect(source).toContain("identifyexecutor");
      expect(source).toContain("getthreadidentity");
      expect(source).toContain('type(WebSocket) == "table"');
      expect(source).toContain("capabilities = {");
      expect(source).toContain("for _, host in ipairs(hosts) do");
      expect(source).toContain('hasGlobal("getconnections")');
      expect(source).toContain('hasGlobal("getluastate")');
      expect(source).toContain('hasGlobal("run_on_actor")');
      expect(source).toContain('hasGlobal("clonefunction")');
      expect(source).toContain('hasGlobal("cloneref")');
      expect(source).toContain('hasGlobal("compareinstances")');
      expect(source).toContain('hasGlobal("getcallingscript")');
      expect(source).toContain('hasGlobal("getscriptclosure")');
      expect(source).toContain('hasGlobal("getsenv")');
      expect(source).toContain('hasGlobal("getfenv")');
      expect(source).toContain('hasGlobal("mouse1click")');
      expect(source).toContain('hasGlobal("keypress")');
    });

    it("forwards threadContext through the runLuau options when supplied", async () => {
      const ctx = mockContext();
      await getConnectorDiagnostics.execute({ threadContext: 5 }, ctx);
      expect(ctx.calls[0]?.options?.threadContext).toBe(5);
    });
  });
});
