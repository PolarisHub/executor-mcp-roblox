import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import listActors from "../../../src/tools/actors-hidden/list-actors.js";
import findHiddenInstances from "../../../src/tools/actors-hidden/find-hidden-instances.js";
import getActorDetails from "../../../src/tools/actors-hidden/get-actor-details.js";
import { actorsHiddenTools } from "../../../src/tools/actors-hidden/index.js";

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

describe("Actors & Hidden tools", () => {
  it("registers all 10 tools in the category index, each tagged correctly", () => {
    expect(actorsHiddenTools).toHaveLength(10);
    for (const tool of actorsHiddenTools) {
      expect(tool.category).toBe("Actors & Hidden");
      // All ten are read-only discovery scans — none mutate live game state.
      expect(tool.mutatesState ?? false).toBe(false);
      expect(tool.requiresClient ?? true).toBe(true);
    }
    const names = actorsHiddenTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
    expect(names).toEqual([
      "find-hidden-scripts",
      "list-actors",
      "get-nil-instances",
      "find-running-scripts",
      "find-hidden-instances",
      "find-hidden-guis",
      "summarize-hidden-surfaces",
      "find-hidden-remotes",
      "get-actor-details",
      "find-detached-instances",
    ]);
  });

  describe("list-actors", () => {
    it("inlines the includeScripts flag, carries the 30s timeout, and drops setthreadidentity", async () => {
      const decoded = { actorCount: 2, truncated: false, actors: [] };
      const ctx = mockContext(decoded);

      const result = await listActors.execute({ includeScripts: true }, ctx);

      expect(result.data).toBe(decoded);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(30000);
      // No threadContext supplied -> not forwarded (gateway default applies).
      expect(options?.threadContext).toBeUndefined();
      expect(source).toContain("local includeScripts = true");
      expect(source).toContain("getactors is not available in this executor.");
      // The HIDDEN_PRELUDE helpers must be present.
      expect(source).toContain("local function __location(inst)");
      // The legacy setthreadidentity prefix must be gone.
      expect(source).not.toContain("setthreadidentity");
    });

    it("emits includeScripts = false and forwards threadContext through the runLuau options", async () => {
      const ctx = mockContext();
      await listActors.execute({ includeScripts: false, threadContext: 7 }, ctx);
      const { source, options } = ctx.calls[0]!;
      expect(source).toContain("local includeScripts = false");
      expect(options?.threadContext).toBe(7);
    });
  });

  describe("find-hidden-instances (whole-registry scan)", () => {
    it("clamps the sample/scan caps and carries the 45s scan timeout", async () => {
      const decoded = { hiddenCount: 0, scannedApprox: 0, samples: [] };
      const ctx = mockContext(decoded);

      const result = await findHiddenInstances.execute({ limit: 99999, maxScan: 9999999 }, ctx);

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      // Whole-registry descendant scan keeps the longer 45s deadline.
      expect(options?.timeoutMs).toBe(45000);
      // limit clamped to 3000, maxScan clamped to 500000.
      expect(source).toContain("local SAMPLE_CAP = 3000");
      expect(source).toContain("local SCAN_CAP = 500000");
      expect(source).toContain("getinstances is not available in this executor.");
    });
  });

  describe("get-actor-details (single-target via __eval)", () => {
    it("emits the single-Actor branch and funnels actorPath through q() when provided", async () => {
      const ctx = mockContext({ name: "Actor", location: "in tree", scripts: [] });

      await getActorDetails.execute({ actorPath: "getactors()[1]" }, ctx);

      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(30000);
      // Single-target branch is selected and the path is a quoted Luau literal.
      expect(source).toContain("local single = true");
      expect(source).toContain('local actor, err = __eval("getactors()[1]")');
      // Both the reflection prelude (__eval) and the hidden prelude (__location) are present.
      expect(source).toContain("local function __eval(expr)");
      expect(source).toContain("local function __location(inst)");
    });

    it("emits the summarize-all branch when actorPath is omitted", async () => {
      const ctx = mockContext({ actorCount: 0, truncated: false, actors: [] });
      await getActorDetails.execute({}, ctx);
      const { source } = ctx.calls[0]!;
      expect(source).toContain("local single = false");
    });
  });
});
