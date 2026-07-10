import { describe, expect, it } from "vitest";
import {
  aggregateAssertionResults,
  assertionAggregatePassed,
  assertionResultPassed,
  assertionResultsPassed,
  buildAssertionLuau,
  normalizeAssertionReport,
  type AssertionResult,
  type LiveAssertion,
} from "../../../src/application/services/assertion-engine.js";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import assertState, { liveAssertionSchema } from "../../../src/tools/intelligence/assert-state.js";

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
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return returnValue;
    },
  } as unknown as ToolContext & { calls: Array<{ source: string; options?: LuauOptions }> };
  return ctx;
}

function liveResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    passed: true,
    expected: true,
    actual: true,
    evidence: { readSucceeded: true, complete: true, confidence: 0.95 },
    errors: [],
    confidence: 0.95,
    ...overrides,
  };
}

function normalizedResult(overrides: Partial<AssertionResult> = {}): AssertionResult {
  return {
    id: "check",
    kind: "path-exists",
    status: "passed",
    passed: true,
    expected: true,
    actual: true,
    evidence: { readSucceeded: true, complete: true, confidence: 0.95 },
    errors: [],
    confidence: 0.95,
    ...overrides,
  };
}

describe("assertion engine", () => {
  it("accepts every predicate family with precise defaults", () => {
    const assertions = [
      { id: "exists", kind: "path-exists", path: "game.Workspace" },
      { id: "gone", kind: "path-not-exists", path: "workspace.Gone" },
      {
        id: "equal",
        kind: "property-equals",
        path: "workspace.Part",
        property: "Name",
        expected: "Part",
      },
      {
        id: "different",
        kind: "property-not-equals",
        path: "workspace.Part",
        property: "Transparency",
        expected: 1,
      },
      {
        id: "contains",
        kind: "property-contains",
        path: "game.Players.LocalPlayer.PlayerGui.Status.Text",
        property: "Text",
        expected: "ready",
      },
      {
        id: "greater",
        kind: "property-greater",
        path: "workspace.Part",
        property: "Transparency",
        expected: 0.2,
      },
      {
        id: "less",
        kind: "property-less",
        path: "workspace.Part",
        property: "Transparency",
        expected: 0.8,
      },
      {
        id: "attribute",
        kind: "attribute-equals",
        path: "workspace.Part",
        attribute: "Owner",
        expected: "Me",
      },
      {
        id: "visible",
        kind: "gui-visible",
        path: "game.Players.LocalPlayer.PlayerGui.Main.Button",
      },
      {
        id: "enabled",
        kind: "gui-enabled",
        path: "game.Players.LocalPlayer.PlayerGui.Main",
      },
      {
        id: "descendant-class",
        kind: "descendant-exists",
        path: "workspace.Map",
        selector: { by: "class", value: "ProximityPrompt" },
      },
      {
        id: "descendant-name",
        kind: "descendant-exists",
        path: "workspace.Map",
        selector: { by: "name", value: "door", match: "contains" },
      },
      {
        id: "descendant-text",
        kind: "descendant-exists",
        path: "game.Players.LocalPlayer.PlayerGui",
        selector: { by: "text", value: "buy" },
      },
      {
        id: "distance",
        kind: "character-distance",
        targetPath: "workspace.Shop.Counter",
        operator: "at-most",
        distance: 12,
      },
      {
        id: "facing",
        kind: "camera-facing",
        targetPath: "workspace.Shop.Counter",
      },
      {
        id: "count",
        kind: "collection-count",
        path: "workspace.Enemies",
        operator: "at-least",
        count: 3,
        selector: { by: "class", value: "Model" },
      },
    ];

    const parsed = assertState.input.parse({ assertions });

    expect(parsed.assertions).toHaveLength(assertions.length);
    expect(parsed.scanLimit).toBe(1500);
    expect(parsed.readBudget).toBe(15000);
    expect(parsed.timeoutMs).toBe(20000);
    expect(parsed.assertions[8]).toMatchObject({
      kind: "gui-visible",
      expected: true,
      effective: true,
    });
    expect(parsed.assertions[10]).toMatchObject({ expected: true });
    expect(parsed.assertions[12]).toMatchObject({
      selector: { match: "contains", caseSensitive: false },
    });
    expect(parsed.assertions[14]).toMatchObject({ maxAngleDegrees: 10 });
    expect(parsed.assertions[15]).toMatchObject({ scope: "children" });
  });

  it("rejects invalid discriminants, numeric predicates with text, duplicate IDs, and unsafe bounds", () => {
    expect(
      liveAssertionSchema.safeParse({
        id: "bad-number",
        kind: "property-greater",
        path: "workspace.Part",
        property: "Transparency",
        expected: "large",
      }).success,
    ).toBe(false);
    expect(
      liveAssertionSchema.safeParse({
        id: "bad-angle",
        kind: "camera-facing",
        targetPath: "workspace.Part",
        maxAngleDegrees: 181,
      }).success,
    ).toBe(false);
    expect(
      assertState.input.safeParse({
        assertions: [
          { id: "same", kind: "path-exists", path: "game" },
          { id: "same", kind: "path-not-exists", path: "workspace.Gone" },
        ],
      }).success,
    ).toBe(false);
    expect(
      assertState.input.safeParse({
        assertions: [{ id: "one", kind: "path-exists", path: "game" }],
        scanLimit: 5001,
      }).success,
    ).toBe(false);
  });

  it("builds one bounded chunk with safe JSON input and every specialized evaluator", () => {
    const source = buildAssertionLuau(
      [
        {
          id: "quoted",
          kind: "property-contains",
          path: 'workspace.Part"; error("injected") --',
          property: "Name",
          expected: "needle\nnext",
          caseSensitive: false,
        },
      ],
      { scanLimit: 100000, readBudget: 100000 },
    );

    expect(source).toContain("local scanLimit = 5000");
    expect(source).toContain("local readBudget = 50000");
    expect(source).toContain("HttpService:JSONDecode");
    expect(source).toContain("evaluateProperty");
    expect(source).toContain("evaluateAttribute");
    expect(source).toContain("evaluateGui");
    expect(source).toContain("evaluateDescendant");
    expect(source).toContain("evaluateDistance");
    expect(source).toContain("evaluateCamera");
    expect(source).toContain("evaluateCollection");
    expect(source).toContain("HumanoidRootPart");
    expect(source).toContain("PrimaryPart");
    expect(source).toContain("Workspace custom model");
    expect(source).toContain("LayerCollector");
    expect(source).toContain("math.acos");
    expect(source).not.toContain('local assertions = workspace.Part"; error');
  });

  it("normalizes ordered results and computes a conservative aggregate", () => {
    const assertions: LiveAssertion[] = [
      { id: "exists", kind: "path-exists", path: "workspace.Part" },
      {
        id: "count",
        kind: "collection-count",
        path: "workspace.Enemies",
        operator: "at-least",
        count: 3,
      },
    ];
    const report = normalizeAssertionReport(
      {
        results: [
          liveResult(),
          liveResult({
            passed: false,
            expected: { operator: "at-least", count: 3 },
            actual: 2,
            evidence: { readSucceeded: true, complete: true, confidence: 0.9 },
            confidence: 0.9,
          }),
        ],
      },
      assertions,
    );

    expect(report.results.map((result) => [result.id, result.status])).toEqual([
      ["exists", "passed"],
      ["count", "failed"],
    ]);
    expect(report.aggregate).toEqual({
      passed: false,
      total: 2,
      passedCount: 1,
      failedCount: 1,
      readFailureCount: 0,
      passRatio: 0.5,
      confidence: 0.9,
    });
    expect(report.passed).toBe(false);
  });

  it("never trusts a claimed pass when its live read failed", () => {
    const assertions: LiveAssertion[] = [
      {
        id: "unreadable",
        kind: "property-not-equals",
        path: "workspace.Secret",
        property: "Value",
        expected: 1,
      },
    ];
    const report = normalizeAssertionReport(
      {
        results: [
          liveResult({
            passed: true,
            actual: "<unavailable>",
            evidence: { readSucceeded: false, complete: false, confidence: 0.95 },
            errors: ["property read denied"],
          }),
        ],
      },
      assertions,
    );

    expect(report.results[0]).toMatchObject({
      status: "failed",
      passed: false,
      confidence: 0,
    });
    expect(report.results[0]?.errors).toEqual([
      "property read denied",
      "A required live read failed or did not complete.",
    ]);
    expect(report.aggregate.readFailureCount).toBe(1);
    expect(report.aggregate.passed).toBe(false);
  });

  it("turns missing or malformed bridge output into explicit failed results", () => {
    const assertions: LiveAssertion[] = [
      { id: "one", kind: "path-exists", path: "game" },
      { id: "two", kind: "path-not-exists", path: "workspace.Gone" },
    ];
    const report = normalizeAssertionReport({ unexpected: true }, assertions);

    expect(report.results).toHaveLength(2);
    expect(report.results.every((result) => !result.passed)).toBe(true);
    expect(report.results[0]?.expected).toBe(true);
    expect(report.results[1]?.expected).toBe(false);
    expect(report.results[0]?.actual).toBe("<unavailable>");
    expect(report.aggregate).toMatchObject({
      passed: false,
      passedCount: 0,
      readFailureCount: 2,
      confidence: 0,
    });
  });

  it("exports pure per-result, aggregate, and threshold gates for orchestrators", () => {
    const passing = normalizedResult();
    const mismatch = normalizedResult({
      id: "mismatch",
      status: "failed",
      passed: false,
      expected: 3,
      actual: 2,
    });
    const dishonest = normalizedResult({
      id: "dishonest",
      passed: true,
      evidence: { readSucceeded: false, confidence: 0 },
    });

    expect(assertionResultPassed(passing)).toBe(true);
    expect(assertionResultPassed(dishonest)).toBe(false);
    const partial = aggregateAssertionResults([passing, mismatch]);
    expect(partial).toMatchObject({ passRatio: 0.5, readFailureCount: 0, passed: false });
    expect(assertionAggregatePassed(partial, 0.5)).toBe(true);
    expect(assertionAggregatePassed(partial)).toBe(false);
    expect(assertionResultsPassed([passing])).toBe(true);
    expect(assertionResultsPassed([passing, dishonest], 0.5)).toBe(false);
    expect(aggregateAssertionResults([])).toMatchObject({
      passed: false,
      passRatio: 0,
      confidence: 0,
    });
  });
});

describe("assert-state tool", () => {
  it("is read-only and executes a complete batch in exactly one bounded call", async () => {
    const ctx = mockContext({ results: [liveResult()] });
    const input = assertState.input.parse({
      assertions: [{ id: "world", kind: "path-exists", path: "game.Workspace" }],
      scanLimit: 222,
      readBudget: 333,
      timeoutMs: 12000,
      threadContext: 4,
    });

    const result = await assertState.execute(input, ctx);

    expect(assertState.category).toBe("Intelligence");
    expect(assertState.mutatesState).toBe(false);
    expect(assertState.ai?.phase).toBe("verify");
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]?.options).toEqual({ timeoutMs: 12000, threadContext: 4 });
    expect(ctx.calls[0]?.source).toContain("local scanLimit = 222");
    expect(ctx.calls[0]?.source).toContain("local readBudget = 333");
    expect(result.isError).toBe(false);
    expect(result.summary).toContain("1/1");
    expect(result.data).toMatchObject({ passed: true, passRatio: 1, confidence: 0.95 });
  });

  it("returns a clean predicate mismatch as explicit verification data", async () => {
    const ctx = mockContext({
      results: [
        liveResult({
          passed: false,
          expected: 100,
          actual: 80,
          evidence: { readSucceeded: true, complete: true, confidence: 0.95 },
        }),
      ],
    });
    const input = assertState.input.parse({
      assertions: [
        {
          id: "health",
          kind: "property-greater",
          path: "workspace.Character.Humanoid",
          property: "Health",
          expected: 100,
        },
      ],
    });

    const result = await assertState.execute(input, ctx);
    const report = result.data as { results: AssertionResult[] };

    expect(ctx.calls).toHaveLength(1);
    expect(result.isError).toBe(false);
    expect(report.results[0]).toMatchObject({
      id: "health",
      kind: "property-greater",
      status: "failed",
      expected: 100,
      actual: 80,
      errors: [],
    });
  });

  it("marks an unreadable assertion as a handled tool error", async () => {
    const ctx = mockContext({
      results: [
        liveResult({
          passed: true,
          actual: "<unavailable>",
          evidence: { readSucceeded: false, complete: false, confidence: 0 },
          errors: ["property read denied"],
        }),
      ],
    });
    const input = assertState.input.parse({
      assertions: [
        {
          id: "secret",
          kind: "property-not-equals",
          path: "workspace.Secret",
          property: "Value",
          expected: 1,
        },
      ],
    });

    const result = await assertState.execute(input, ctx);

    expect(ctx.calls).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({
      passed: false,
      aggregate: { readFailureCount: 1, confidence: 0 },
    });
  });
});
