import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import listRemotes from "../../../src/tools/remote-spy/list-remotes.js";
import monitorRemote from "../../../src/tools/remote-spy/monitor-remote.js";
import ensureRemoteSpy from "../../../src/tools/remote-spy/ensure-remote-spy.js";
import blockRemote from "../../../src/tools/remote-spy/block-remote.js";
import { remoteSpyTools } from "../../../src/tools/remote-spy/index.js";

/**
 * A minimal ToolContext stub whose runLuau records the source string and the
 * options it was called with, then returns a canned value. No socket, no game —
 * we only assert that the tool builds the expected Luau and returns { data }.
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

describe("remote-spy tools", () => {
  it("exports all 10 tools with unique names in the Remote Spy category", () => {
    expect(remoteSpyTools).toHaveLength(10);
    const names = remoteSpyTools.map((t) => t.name);
    expect(new Set(names).size).toBe(10);
    for (const tool of remoteSpyTools) {
      expect(tool.category).toBe("Remote Spy");
    }
  });

  it("marks exactly the hook-installing / state-writing tools as mutatesState", () => {
    const mutating = remoteSpyTools
      .filter((t) => t.mutatesState === true)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual(
      ["block-remote", "ensure-remote-spy", "monitor-remote", "trace-remote-traffic"].sort(),
    );
  });

  describe("list-remotes (ported)", () => {
    it("quotes the root into __eval and returns the canned data", async () => {
      const canned = { ok: true, total: 3, remotes: [] };
      const { ctx, calls } = stubContext(canned);
      const input = listRemotes.input.parse({
        root: 'game:GetService("ReplicatedStorage")',
      });

      const result = await listRemotes.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      // Root expression is quoted into the resolver, RemoteEvent class is matched.
      expect(source).toContain(
        'local rootInst, err = __eval("game:GetService(\\"ReplicatedStorage\\")")',
      );
      expect(source).toContain("RemoteEvent = true");
      // Read-only scan: 45s budget, threadContext undefined here.
      expect(options?.timeoutMs).toBe(45000);
      expect(options?.threadContext).toBeUndefined();
    });

    it("defaults root to 'game' and passes threadContext through", async () => {
      const { ctx, calls } = stubContext({});
      const input = listRemotes.input.parse({ threadContext: 3 });

      await listRemotes.execute(input, ctx);

      expect(calls[0]?.source).toContain('local rootInst, err = __eval("game")');
      expect(calls[0]?.options?.threadContext).toBe(3);
    });
  });

  describe("monitor-remote (ported)", () => {
    it("refuses without remotePath and never calls runLuau", async () => {
      const { ctx, calls } = stubContext({});
      const input = monitorRemote.input.parse({ action: "start" });

      const result = await monitorRemote.execute(input, ctx);

      expect(result.isError).toBe(true);
      expect((result.data as { error: string }).error).toContain("remotePath is required");
      expect(calls).toHaveLength(0);
    });

    it("installs the __namecall hook for action=start with the remote keyed by reference", async () => {
      const canned = { started: true, remote: "BuyItem" };
      const { ctx, calls } = stubContext(canned);
      const input = monitorRemote.input.parse({
        action: "start",
        remotePath: "game.ReplicatedStorage.Remotes.BuyItem",
      });

      const result = await monitorRemote.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source, options } = calls[0]!;
      expect(source).toContain('local __KEY = "game.ReplicatedStorage.Remotes.BuyItem"');
      expect(source).toContain('pcall(hookmetamethod, game, "__namecall", hook)');
      expect(source).toContain("if self ~= e.target then return end");
      expect(options?.timeoutMs).toBe(15000);
    });

    it("uses the 20s fetch budget and clamps the limit into the source", async () => {
      const { ctx, calls } = stubContext({});
      const input = monitorRemote.input.parse({
        action: "fetch",
        remotePath: "game.ReplicatedStorage.Remotes.BuyItem",
        limit: 9999,
      });

      await monitorRemote.execute(input, ctx);

      const { source, options } = calls[0]!;
      expect(options?.timeoutMs).toBe(20000);
      // limit clamped to the 500-entry ring buffer.
      expect(source).toContain("local limit = 500");
    });
  });

  describe("ensure-remote-spy (reimplemented)", () => {
    it("builds an idempotent __namecall hook over a getgenv state table", async () => {
      const canned = { installed: true, alreadyActive: false };
      const { ctx, calls } = stubContext(canned);
      const input = ensureRemoteSpy.input.parse({ max: 250 });

      const result = await ensureRemoteSpy.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source } = calls[0]!;
      // Self-contained getgenv ring buffer + block/ignore sets.
      expect(source).toContain("local st = genv.__mcp_remoteSpy");
      expect(source).toContain('if type(st.blocked) ~= "table" then st.blocked = {} end');
      expect(source).toContain('if type(st.ignored) ~= "table" then st.ignored = {} end');
      // Idempotency guard: already-active returns installed=false.
      expect(source).toContain("alreadyActive = true");
      // Tracks the data-sending namecalls only.
      expect(source).toContain("local TRACKED = { FireServer = true, InvokeServer = true }");
      // Capacity clamped from input.
      expect(source).toContain("st.max = 250");
      // Blocked remotes are dropped (no call-through).
      expect(source).toContain("if blocked then return end");
    });

    it("clamps max to the 10..5000 window", async () => {
      const { ctx, calls } = stubContext({});
      const input = ensureRemoteSpy.input.parse({ max: 1 });

      await ensureRemoteSpy.execute(input, ctx);

      expect(calls[0]?.source).toContain("st.max = 10");
    });
  });

  describe("block-remote (reimplemented)", () => {
    it("resolves the remote and adds its full path to the block-set", async () => {
      const canned = { blocked: true, remote: "Workspace.Remotes.BuyItem" };
      const { ctx, calls } = stubContext(canned);
      const input = blockRemote.input.parse({
        remotePath: "game.ReplicatedStorage.Remotes.BuyItem",
      });

      const result = await blockRemote.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source } = calls[0]!;
      // Requires the spy to already be installed.
      expect(source).toContain("remote spy is not installed");
      // Quotes the path into __eval and keys the block-set by GetFullName.
      expect(source).toContain(
        'local remote, err = __eval("game.ReplicatedStorage.Remotes.BuyItem")',
      );
      expect(source).toContain("st.blocked[path] = true");
    });

    it("is a state-mutating tool", () => {
      expect(blockRemote.mutatesState).toBe(true);
    });
  });
});
