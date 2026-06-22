import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import verifyPathExists from "../../../src/tools/inspection/verify-path-exists.js";
import scriptGrep from "../../../src/tools/inspection/script-grep.js";
import getScriptContent from "../../../src/tools/inspection/get-script-content.js";
import watchInstanceProperty from "../../../src/tools/inspection/watch-instance-property.js";
import { inspectionTools } from "../../../src/tools/inspection/index.js";

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

describe("Inspection tools", () => {
  it("registers all 12 tools in the category index, each tagged correctly", () => {
    expect(inspectionTools).toHaveLength(12);
    for (const tool of inspectionTools) {
      expect(tool.category).toBe("Inspection");
      // Every Inspection tool is read-only — watch-instance-property is a blocking
      // read window, not a mutation; trace-connection-function only inspects.
      expect(tool.mutatesState ?? false).toBe(false);
      expect(tool.requiresClient ?? true).toBe(true);
    }
    const names = inspectionTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
  });

  describe("verify-path-exists", () => {
    it("funnels the path through q(), carries the 15s timeout, and drops setthreadidentity", async () => {
      const decoded = { exists: true, Path: "game.Workspace", className: "Workspace" };
      const ctx = mockContext(decoded);

      const result = await verifyPathExists.execute({ path: "game.Workspace" }, ctx);

      expect(result.data).toBe(decoded);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(15000);
      // No threadContext supplied -> not forwarded (gateway default applies).
      expect(options?.threadContext).toBeUndefined();
      expect(source).toContain('local path = "game.Workspace"');
      // The legacy setthreadidentity prefix must be gone.
      expect(source).not.toContain("setthreadidentity");
    });

    it("forwards threadContext through the runLuau options when supplied", async () => {
      const ctx = mockContext();
      await verifyPathExists.execute({ path: "game", threadContext: 3 }, ctx);
      expect(ctx.calls[0]?.options?.threadContext).toBe(3);
    });
  });

  describe("script-grep", () => {
    it("inlines the literal/caseSensitive flags and the query, with the long decompile timeout", async () => {
      const decoded = { Query: "Humanoid", TotalMatches: 0, Results: [] };
      const ctx = mockContext(decoded);

      const result = await scriptGrep.execute(
        {
          query: "Humanoid",
          root: "game",
          limit: 50,
          contextLines: 2,
          maxMatchesPerScript: 20,
          maxScripts: 400,
          literal: true,
          caseSensitive: false,
        },
        ctx,
      );

      expect(result.data).toBe(decoded);
      const { source, options } = ctx.calls[0]!;
      // Decompiling many scripts is slow — the tool gives the round-trip a long budget.
      expect(options?.timeoutMs).toBe(120000);
      expect(source).toContain('local query = "Humanoid"');
      expect(source).toContain("local literal = true");
      expect(source).toContain("local caseSensitive = false");
      // Re-implemented in-game: it must enumerate LuaSourceContainers and decompile.
      expect(source).toContain('QueryDescendants("LuaSourceContainer")');
      expect(source).toContain("decompile(inst)");
    });
  });

  describe("get-script-content (JS-side argument validation)", () => {
    it("rejects when neither scriptGetterSource nor scriptPath is provided, without calling runLuau", async () => {
      const ctx = mockContext();
      const result = await getScriptContent.execute({}, ctx);
      expect(result.isError).toBe(true);
      expect((result.data as { error: string }).error).toContain("either");
      expect(ctx.calls).toHaveLength(0);
    });

    it("rejects when both scriptGetterSource and scriptPath are provided", async () => {
      const ctx = mockContext();
      const result = await getScriptContent.execute(
        { scriptGetterSource: "return script", scriptPath: "game.X" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(ctx.calls).toHaveLength(0);
    });

    it("wraps a bare scriptPath into a `return <path>` getter and uses the 60s timeout", async () => {
      const ctx = mockContext({ path: "game.X", source: "print(1)" });
      await getScriptContent.execute({ scriptPath: "game.Workspace.MyScript" }, ctx);
      expect(ctx.calls).toHaveLength(1);
      const { source, options } = ctx.calls[0]!;
      expect(options?.timeoutMs).toBe(60000);
      expect(source).toContain('loadstring("return game.Workspace.MyScript")');
    });
  });

  describe("watch-instance-property (blocking read window)", () => {
    it("derives the runLuau timeout from the watch duration plus a buffer", async () => {
      const ctx = mockContext({ Path: "game.X", Samples: [] });
      await watchInstanceProperty.execute(
        { instancePath: "game.X", propertyName: "Visible", checkIntervalMs: 100, durationMs: 3000 },
        ctx,
      );
      // duration (3000) + 10000 buffer so the loop finishes before the round-trip deadline.
      expect(ctx.calls[0]?.options?.timeoutMs).toBe(13000);
    });
  });
});
