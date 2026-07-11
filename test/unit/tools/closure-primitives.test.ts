import { describe, expect, it } from "vitest";

import { matchWorkflows } from "../../../src/application/services/tool-discovery.js";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import { metatablesTools } from "../../../src/tools/metatables/index.js";
import { silentLogger } from "../../helpers/fakes.js";

function mockContext(returnValue: unknown = { ok: true }): {
  ctx: ToolContext;
  calls: Array<{ source: string; options?: LuauOptions }>;
} {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const ctx = {
    logger: silentLogger(),
    signal: new AbortController().signal,
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return returnValue;
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

const addedNames = [
  "closure-capabilities",
  "check-caller",
  "clone-function",
  "get-function-hash",
  "is-c-closure",
  "is-l-closure",
  "is-executor-closure",
  "is-function-hooked",
  "is-new-c-closure",
  "new-c-closure",
  "new-l-closure",
  "restore-function",
  "set-stack-hidden",
  "invoke-closure",
  "set-function-env",
  "list-closure-references",
  "release-closure-reference",
] as const;

function tool(name: string) {
  const found = metatablesTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

describe("Volt closure primitives", () => {
  it("registers the complete added closure surface with unique names", () => {
    const names = metatablesTools.map((candidate) => candidate.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of addedNames) expect(names).toContain(name);
    for (const name of addedNames) expect(tool(name).category).toBe("Metatables & Closures");
  });

  it("marks and labels every behavior-changing primitive", () => {
    const mutating = [
      "restore-function",
      "set-stack-hidden",
      "invoke-closure",
      "set-function-env",
      "release-closure-reference",
    ];
    for (const name of mutating) {
      expect(tool(name).mutatesState).toBe(true);
      expect(tool(name).description).toContain("WRITES LIVE GAME STATE");
    }
  });

  it("refuses confirmation-gated closure actions before running Luau", async () => {
    const cases: Array<{ name: string; input: Record<string, unknown> }> = [
      { name: "restore-function", input: { functionPath: "print", confirm: false } },
      {
        name: "set-stack-hidden",
        input: { functionPath: "print", hidden: true, confirm: false },
      },
      {
        name: "invoke-closure",
        input: { functionPath: "print", arguments: [], confirm: false },
      },
      {
        name: "set-function-env",
        input: { functionPath: "print", environmentExpression: "{}", confirm: false },
      },
      { name: "release-closure-reference", input: { key: "x", confirm: false } },
    ];
    for (const item of cases) {
      const { ctx, calls } = mockContext();
      const result = await tool(item.name).execute(item.input, ctx);
      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    }
  });

  it("retains cloned functions behind stable getgenv references", async () => {
    const { ctx, calls } = mockContext({ Key: "copy", Reference: "ref" });
    await tool("clone-function").execute(
      { functionPath: 'getsenv(game["Main"]).run', key: "copy" },
      ctx,
    );
    const source = calls[0]?.source ?? "";
    expect(source).toContain("clonefunction");
    expect(source).toContain("clonefunc");
    expect(source).toContain("genv.__mcp_closure_refs");
    expect(source).toContain('__storeClosure(cloned, "copy")');
    expect(source).toContain("closure reference key already exists");
    expect(source).toContain('__evalFn("getsenv(game[\\"Main\\"]).run")');
    expect(source).toContain("pcall(clone, fn)");
  });

  it("supports predicate aliases and pcall-wrapped classification", async () => {
    const { ctx, calls } = mockContext();
    await tool("is-executor-closure").execute({ functionPath: "print" }, ctx);
    const executorSource = calls[0]?.source ?? "";
    expect(executorSource).toContain("isexecutorclosure");
    expect(executorSource).toContain("checkclosure");
    expect(executorSource).toContain("isourclosure");
    expect(executorSource).toContain("pcall(predicate, fn)");

    await tool("is-new-c-closure").execute({ functionPath: "print" }, ctx);
    expect(calls[1]?.source).toContain("iscustomcclosure");
  });

  it("forwards typed invoke arguments only after confirmation", async () => {
    const { ctx, calls } = mockContext({ ok: true });
    await tool("invoke-closure").execute(
      {
        functionPath: "getgenv().__mcp_closure_refs.copy",
        arguments: [
          { kind: "string", value: "hello" },
          { kind: "number", value: 42 },
          { kind: "boolean", value: true },
        ],
        confirm: true,
        threadContext: 7,
      },
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toContain('local args = { "hello", 42, true }');
    expect(calls[0]?.source).toContain("table.pack(pcall(fn");
    expect(calls[0]?.source).toContain("math.min(packed.n, 21)");
    expect(calls[0]?.options).toEqual({ threadContext: 7, timeoutMs: 30000 });
  });

  it("probes all official closure functions and debug companions without invoking them", async () => {
    const { ctx, calls } = mockContext();
    await tool("closure-capabilities").execute({}, ctx);
    const source = calls[0]?.source ?? "";
    for (const name of [
      "checkcaller",
      "clonefunction",
      "getfunctionhash",
      "hookfunction",
      "hookmetamethod",
      "newcclosure",
      "newlclosure",
      "restorefunction",
      "setstackhidden",
      "getconstants",
      "getupvalues",
      "getprotos",
      "setfenv",
    ]) {
      expect(source).toContain(`add("${name}"`);
    }
  });

  it("routes closure goals through capability probing before inspection", () => {
    const matches = matchWorkflows(
      "inspect closure upvalues and function hash",
      new Set(["closure-capabilities", "inspect-closure", "is-function-hooked"]),
    );
    const closure = matches.find((match) => match.id === "inspect-closure");
    expect(closure?.steps.map((step) => step.tool)).toEqual([
      "closure-capabilities",
      "inspect-closure",
      "is-function-hooked",
    ]);
  });

  it("parses defaults and generates concrete Luau for every added tool", async () => {
    const rawInputs: Record<string, Record<string, unknown>> = {
      "closure-capabilities": {},
      "check-caller": {},
      "clone-function": { functionPath: "function() end" },
      "get-function-hash": { functionPath: "function() end" },
      "is-c-closure": { functionPath: "function() end" },
      "is-l-closure": { functionPath: "function() end" },
      "is-executor-closure": { functionPath: "function() end" },
      "is-function-hooked": { functionPath: "function() end" },
      "is-new-c-closure": { functionPath: "function() end" },
      "new-c-closure": { functionPath: "function() end" },
      "new-l-closure": { functionPath: "print" },
      "restore-function": { functionPath: "print", confirm: true },
      "set-stack-hidden": { functionPath: "print", hidden: false, confirm: true },
      "invoke-closure": { functionPath: "function() end", confirm: true },
      "set-function-env": {
        functionPath: "function() end",
        environmentExpression: "{}",
        confirm: true,
      },
      "list-closure-references": {},
      "release-closure-reference": { key: "test", confirm: true },
    };
    for (const name of addedNames) {
      const target = tool(name);
      const input = target.input.parse(rawInputs[name]);
      const { ctx, calls } = mockContext();
      await target.execute(input, ctx);
      expect(calls, name).toHaveLength(1);
      expect(calls[0]?.source, name).not.toContain("undefined");
    }
  });
});
