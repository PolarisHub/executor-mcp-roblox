import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import { silentLogger } from "../../helpers/fakes.js";

import getMetatable from "../../../src/tools/metatables/get-metatable.js";
import setClosureUpvalue from "../../../src/tools/metatables/set-closure-upvalue.js";
import listHooks from "../../../src/tools/metatables/list-hooks.js";
import { metatablesTools } from "../../../src/tools/metatables/index.js";

/** A ToolContext whose runLuau records its call and returns a canned decoded value. */
function mockContext(returnValue: unknown = null): {
  ctx: ToolContext;
  calls: Array<{ source: string; options?: LuauOptions }>;
} {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const ctx = {
    logger: silentLogger(),
    signal: new AbortController().signal,
    client: undefined,
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return returnValue;
    },
    clients: { list: () => [], get: () => undefined },
    session: undefined as never,
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("metatables category index", () => {
  it("exports the metatable and complete closure surfaces with unique names", () => {
    expect(metatablesTools).toHaveLength(36);
    const names = metatablesTools.map((t) => t.name);
    expect(new Set(names).size).toBe(36);
  });

  it("labels every mutating tool with mutatesState and the live-state phrase", () => {
    const mutating = new Set([
      "set-metatable-readonly",
      "set-rawmetatable",
      "hook-metamethod",
      "set-closure-upvalue",
      "set-closure-constant",
      "hook-function",
      "restore-hook",
      "restore-function",
      "set-stack-hidden",
      "invoke-closure",
      "set-function-env",
      "release-closure-reference",
    ]);
    for (const tool of metatablesTools) {
      expect(tool.category).toBe("Metatables & Closures");
      if (mutating.has(tool.name)) {
        expect(tool.mutatesState).toBe(true);
        expect(tool.description).toContain("WRITES LIVE GAME STATE");
      } else {
        expect(tool.mutatesState ?? false).toBe(false);
      }
    }
  });
});

describe("get-metatable", () => {
  it("builds Luau that evaluates the objectPath and returns the decoded result verbatim", async () => {
    const decoded = { Target: "game", TargetType: "Instance", HasMetatable: true };
    const { ctx, calls } = mockContext(decoded);

    const result = await getMetatable.execute({ objectPath: "game" }, ctx);

    expect(calls).toHaveLength(1);
    const { source, options } = calls[0]!;
    // The objectPath is quoted into the source via __eval.
    expect(source).toContain('__eval("game")');
    expect(source).toContain("getrawmetatable");
    // Legacy timeout preserved; threadContext passes through (undefined -> gateway default).
    expect(options).toEqual({ threadContext: undefined, timeoutMs: 20000 });
    // The connector decodes the table, so the tool returns it directly as { data }.
    expect(result).toEqual({ data: decoded });
  });

  it("forwards an explicit threadContext", async () => {
    const { ctx, calls } = mockContext({});
    await getMetatable.execute({ objectPath: "game", threadContext: 2 }, ctx);
    expect(calls[0]?.options).toEqual({ threadContext: 2, timeoutMs: 20000 });
  });
});

describe("set-closure-upvalue", () => {
  it("refuses without confirm=true and never calls runLuau", async () => {
    const { ctx, calls } = mockContext({});

    const result = await setClosureUpvalue.execute(
      {
        functionPath: "getsenv(s).f",
        index: 1,
        value: { kind: "boolean", value: true },
        confirm: false,
      },
      ctx,
    );

    expect(calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.data).toEqual({
      error: "Refusing to set closure upvalue (mutates live state); pass confirm=true.",
    });
  });

  it("when confirmed, builds the setupvalue call with the encoded value expression", async () => {
    const decoded = { Target: "getsenv(s).f", Index: 2, ok: true };
    const { ctx, calls } = mockContext(decoded);

    const result = await setClosureUpvalue.execute(
      {
        functionPath: "getsenv(s).f",
        index: 2,
        value: { kind: "string", value: "patched" },
        confirm: true,
      },
      ctx,
    );

    expect(calls).toHaveLength(1);
    const { source, options } = calls[0]!;
    expect(source).toContain("setupvalue");
    expect(source).toContain('__evalFn("getsenv(s).f")');
    // index + quoted string literal land in the call.
    expect(source).toContain('__setupvalue, fn, 2, "patched"');
    expect(options).toEqual({ threadContext: undefined, timeoutMs: 20000 });
    expect(result).toEqual({ data: decoded });
  });
});

describe("list-hooks", () => {
  it("reads getgenv().__mcp_hooks with the legacy 15s timeout and returns decoded data", async () => {
    const decoded = { Count: 0, Hooks: [] };
    const { ctx, calls } = mockContext(decoded);

    const result = await listHooks.execute({}, ctx);

    expect(calls).toHaveLength(1);
    const { source, options } = calls[0]!;
    expect(source).toContain("genv.__mcp_hooks");
    expect(options).toEqual({ threadContext: undefined, timeoutMs: 15000 });
    expect(result).toEqual({ data: decoded });
  });
});
