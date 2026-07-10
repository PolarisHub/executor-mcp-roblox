import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  ToolDescriptor,
  ToolDirectory,
} from "../../../src/application/ports/tool-directory.js";
import type { ToolContext, ToolResult } from "../../../src/application/tool/tool.js";
import assertState from "../../../src/tools/intelligence/assert-state.js";
import explainFailure from "../../../src/tools/intelligence/explain-failure.js";
import smartTask from "../../../src/tools/intelligence/smart-task.js";

function tool(
  name: string,
  input: z.ZodTypeAny,
  options: { mutatesState?: boolean; description?: string } = {},
): ToolDescriptor {
  return {
    name,
    title: name.replaceAll("-", " "),
    description: options.description ?? `${name} test tool`,
    category: options.mutatesState ? "Actions" : "Inspection",
    mutatesState: options.mutatesState ?? false,
    requiresClient: false,
    input,
  };
}

function context(
  descriptors: readonly ToolDescriptor[],
  invokeTool: (name: string, input: unknown) => Promise<ToolResult>,
): ToolContext {
  const directory: ToolDirectory = {
    list: () => descriptors,
    find: (name) => descriptors.find((descriptor) => descriptor.name === name) ?? null,
  };
  return {
    tools: directory,
    signal: new AbortController().signal,
    invokeTool,
  } as unknown as ToolContext;
}

async function execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  return smartTask.execute(smartTask.input.parse(input), ctx);
}

describe("smart-task", () => {
  it("builds a schema-aware plan without guessing required arguments", async () => {
    const descriptors = [
      tool(
        "search-instances",
        z.object({ query: z.string(), limit: z.number().optional().default(50) }),
        { description: "Find and locate game instances by name." },
      ),
      tool("get-instance-properties", z.object({ path: z.string() }), {
        description: "Inspect instance properties.",
      }),
    ];
    let calls = 0;
    const result = await execute(
      { goal: "find an instance in the game", mode: "execute" },
      context(descriptors, async () => {
        calls += 1;
        return { data: null };
      }),
    );
    const data = result.data as {
      status: string;
      workflows: Array<{
        steps: Array<{ name: string; input: unknown; requiredArguments: string[] }>;
      }>;
      alternatives: Array<{ name: string; input: unknown; requiredArguments: string[] }>;
      strategy: string;
    };
    expect(data.status).toBe("plan-only");
    expect(data.strategy).toContain("no LLM");
    expect(calls).toBe(0);
    const search = data.alternatives.find((entry) => entry.name === "search-instances");
    expect(search).toMatchObject({ input: null, requiredArguments: ["query"] });
    expect(data.workflows[0]?.steps[0]).toMatchObject({
      name: "search-instances",
      input: null,
      requiredArguments: ["query"],
    });
  });

  it("previews typed steps and mutation approval without invoking tools", async () => {
    const descriptors = [
      tool("set-value", z.object({ path: z.string(), value: z.unknown() }), {
        mutatesState: true,
      }),
    ];
    let calls = 0;
    const result = await execute(
      {
        goal: "set a value",
        mode: "preview",
        steps: [{ id: "write", phase: "act", tool: "set-value", input: { path: "x", value: 1 } }],
      },
      context(descriptors, async () => {
        calls += 1;
        return { data: null };
      }),
    );
    const data = result.data as {
      status: string;
      canExecute: boolean;
      validation: Array<{ code: string }>;
      plan: { main: Array<{ mutationApproved: boolean; schemaValidation: string }> };
    };
    expect(data.status).toBe("preview");
    expect(data.canExecute).toBe(true);
    expect(data.validation).toContainEqual(
      expect.objectContaining({ code: "mutation-not-approved" }),
    );
    expect(data.plan.main[0]).toMatchObject({
      mutationApproved: false,
      schemaValidation: "checked",
    });
    expect(calls).toBe(0);
  });

  it("resolves step references and requires explicit assertion truth", async () => {
    const descriptors = [
      tool("find-target", z.object({ query: z.string() })),
      tool("set-value", z.object({ path: z.string(), value: z.number() }), {
        mutatesState: true,
      }),
      tool("assert-state", assertState.input),
      tool("explain-failure", explainFailure.input),
    ];
    const calls: Array<{ name: string; input: unknown }> = [];
    const result = await execute(
      {
        goal: "find and update cash",
        mode: "execute",
        allowMutations: true,
        budgets: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 10_000 },
        steps: [
          { id: "find", phase: "observe", tool: "find-target", input: { query: "cash" } },
          {
            id: "write",
            phase: "act",
            tool: "set-value",
            input: { path: "$steps.find.data.path", value: 100 },
            assertions: [
              {
                id: "cash-updated",
                kind: "property-equals",
                path: "$steps.find.data.path",
                property: "Value",
                expected: 100,
              },
            ],
          },
        ],
      },
      context(descriptors, async (name, input) => {
        calls.push({ name, input });
        if (name === "find-target") return { data: { path: "game.Players.LocalPlayer.Cash" } };
        if (name === "set-value") return { data: { applied: true } };
        if (name === "assert-state") {
          assertState.input.parse(input);
          return {
            data: {
              passed: true,
              aggregate: { passed: true },
              results: [{ id: "cash-updated", passed: true, actual: 100 }],
            },
          };
        }
        throw new Error(`Unexpected call ${name}`);
      }),
    );
    const data = result.data as {
      status: string;
      budgetsConsumed: { toolCalls: { used: number } };
      completionConfidence: { score: number; level: string };
      unresolvedAssertions: unknown[];
      evidenceTimeline: Array<{ kind: string; status: string }>;
    };
    expect(data.status).toBe("completed");
    expect(result.isError).toBe(false);
    expect(calls.map(({ name }) => name)).toEqual(["find-target", "set-value", "assert-state"]);
    expect(calls[1]?.input).toEqual({ path: "game.Players.LocalPlayer.Cash", value: 100 });
    expect(calls[2]?.input).toMatchObject({
      stepId: "write",
      assertions: [
        expect.objectContaining({
          id: "cash-updated",
          kind: "property-equals",
          path: "game.Players.LocalPlayer.Cash",
          expected: 100,
        }),
      ],
    });
    expect(data.budgetsConsumed.toolCalls.used).toBe(3);
    expect(data.completionConfidence).toMatchObject({ score: 0.98, level: "high" });
    expect(data.unresolvedAssertions).toEqual([]);
    expect(data.evidenceTimeline).toContainEqual(
      expect.objectContaining({ kind: "assertion", status: "passed" }),
    );
  });

  it("diagnoses failed assertions, runs only an explicit fallback, and rechecks truth", async () => {
    const descriptors = [
      tool("open-door", z.object({ path: z.string() }), { mutatesState: true }),
      tool("repair-door", z.object({ path: z.string() }), { mutatesState: true }),
      tool("assert-state", assertState.input),
      tool("explain-failure", explainFailure.input),
    ];
    const calls: Array<{ name: string; input: unknown }> = [];
    let assertionCalls = 0;
    const result = await execute(
      {
        goal: "open the door and prove it",
        mode: "execute",
        allowMutations: true,
        budgets: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 10_000 },
        steps: [
          {
            id: "open",
            tool: "open-door",
            input: { path: "game.Workspace.Door" },
            assertions: [
              {
                id: "door-open",
                kind: "property-equals",
                path: "game.Workspace.Door",
                property: "Transparency",
                expected: 1,
              },
            ],
            recoverWith: ["repair"],
          },
        ],
        fallbacks: [
          {
            id: "repair",
            when: "assertion-failed",
            steps: [
              { id: "repair-action", tool: "repair-door", input: { path: "game.Workspace.Door" } },
            ],
            resolvesAssertions: ["door-open"],
          },
        ],
      },
      context(descriptors, async (name, input) => {
        calls.push({ name, input });
        if (name === "assert-state") {
          assertState.input.parse(input);
          assertionCalls += 1;
          return {
            data: {
              passed: assertionCalls === 2,
              aggregate: { passed: assertionCalls === 2 },
              results: [{ id: "door-open", passed: assertionCalls === 2 }],
            },
          };
        }
        if (name === "explain-failure") {
          explainFailure.input.parse(input);
          return { data: { nextActions: ["Use the declared repair branch."] } };
        }
        return { data: { applied: true } };
      }),
    );
    const data = result.data as {
      status: string;
      failures: Array<{ recovered: boolean; recoveryBranch?: string }>;
      unresolvedAssertions: unknown[];
      recoveryRecommendations: string[];
      evidenceTimeline: Array<{ kind: string; status: string; branchId?: string }>;
    };
    expect(calls.map(({ name }) => name)).toEqual([
      "open-door",
      "assert-state",
      "explain-failure",
      "repair-door",
      "assert-state",
    ]);
    expect(calls[2]?.input).toMatchObject({
      toolName: "open-door",
      attemptedInput: { path: "game.Workspace.Door" },
      context: { stepId: "open", failureKind: "assertion-failed" },
    });
    expect(data.status).toBe("completed");
    expect(data.failures[0]).toMatchObject({ recovered: true, recoveryBranch: "repair" });
    expect(data.unresolvedAssertions).toEqual([]);
    expect(data.recoveryRecommendations).toContain("Use the declared repair branch.");
    expect(data.evidenceTimeline).toContainEqual(
      expect.objectContaining({ kind: "fallback", status: "recovered", branchId: "repair" }),
    );
  });

  it("diagnoses handled errors and chooses only a matching declared branch", async () => {
    const descriptors = [
      tool("primary-write", z.object({ path: z.string() }), { mutatesState: true }),
      tool("wrong-recovery", z.object({})),
      tool("safe-recovery", z.object({ code: z.string() })),
      tool("explain-failure", explainFailure.input),
    ];
    const calls: Array<{ name: string; input: unknown }> = [];
    const result = await execute(
      {
        goal: "write through a stale path with explicit recovery",
        mode: "execute",
        allowMutations: true,
        budgets: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 10_000 },
        steps: [
          {
            id: "primary",
            tool: "primary-write",
            input: { path: "game.Workspace.Old" },
            recoverWith: ["wrong-kind", "safe"],
          },
        ],
        fallbacks: [
          {
            id: "wrong-kind",
            when: "assertion-failed",
            steps: [{ id: "wrong", tool: "wrong-recovery", input: {} }],
          },
          {
            id: "safe",
            when: "tool-error",
            steps: [
              {
                id: "recover",
                tool: "safe-recovery",
                input: { code: "$steps.primary.data.code" },
              },
            ],
          },
        ],
      },
      context(descriptors, async (name, input) => {
        calls.push({ name, input });
        if (name === "primary-write") {
          return { data: { code: "stale-path" }, summary: "Path is stale.", isError: true };
        }
        if (name === "explain-failure") {
          explainFailure.input.parse(input);
          return { data: { cause: "stale-or-missing-instance-path", nextActions: [] } };
        }
        if (name === "safe-recovery") return { data: { rediscovered: true } };
        throw new Error(`Unexpected call ${name}`);
      }),
    );
    const data = result.data as {
      status: string;
      failures: Array<{ recovered: boolean; recoveryBranch?: string }>;
    };
    expect(calls.map(({ name }) => name)).toEqual([
      "primary-write",
      "explain-failure",
      "safe-recovery",
    ]);
    expect(calls[2]?.input).toEqual({ code: "stale-path" });
    expect(data.status).toBe("completed");
    expect(data.failures[0]).toMatchObject({ recovered: true, recoveryBranch: "safe" });
  });

  it("rejects unsafe or not-yet-resolved $steps paths before nested invocation", async () => {
    const descriptors = [
      tool("get-data", z.object({})),
      tool("read-value", z.object({ path: z.string() })),
    ];
    const calls: string[] = [];
    const result = await execute(
      {
        goal: "resolve a hostile reference safely",
        mode: "execute",
        steps: [
          { id: "first", tool: "get-data", input: {} },
          {
            id: "unsafe",
            tool: "read-value",
            input: { path: "$steps.first.data.__proto__.polluted" },
            onFailure: "continue",
          },
        ],
      },
      context(descriptors, async (name) => {
        calls.push(name);
        return { data: { path: "game.Workspace.Safe" } };
      }),
    );
    const data = result.data as {
      status: string;
      failures: Array<{ message: string }>;
    };
    expect(calls).toEqual(["get-data"]);
    expect(data.status).toBe("partial");
    expect(data.failures[0]?.message).toContain("Unsafe step reference path");
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("blocks repeated identical mutations and enforces the tool-call budget", async () => {
    const mutation = tool("set-value", z.object({ path: z.string(), value: z.number() }), {
      mutatesState: true,
    });
    const mutationCalls: Array<{ name: string; input: unknown }> = [];
    const repeated = await execute(
      {
        goal: "set the same value twice",
        mode: "execute",
        allowMutations: true,
        budgets: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 10_000 },
        steps: [
          { id: "first", tool: "set-value", input: { path: "x", value: 1 } },
          {
            id: "second",
            tool: "set-value",
            input: { path: "x", value: 1 },
            onFailure: "continue",
          },
        ],
      },
      context([mutation], async (name, input) => {
        mutationCalls.push({ name, input });
        return { data: { applied: true } };
      }),
    );
    const repeatedData = repeated.data as {
      status: string;
      failures: Array<{ kind: string; recovered: boolean }>;
      evidenceTimeline: Array<{ kind: string; status: string }>;
    };
    expect(mutationCalls).toHaveLength(1);
    expect(repeatedData.status).toBe("partial");
    expect(repeatedData.failures).toContainEqual(
      expect.objectContaining({ kind: "loop", recovered: false }),
    );
    expect(repeatedData.evidenceTimeline).toContainEqual(
      expect.objectContaining({ kind: "loop", status: "blocked" }),
    );

    const reads = tool("read-value", z.object({ path: z.string() }));
    let readCalls = 0;
    const budgeted = await execute(
      {
        goal: "read two values",
        mode: "execute",
        budgets: { maxSteps: 10, maxToolCalls: 1, timeoutMs: 10_000 },
        steps: [
          { id: "one", tool: "read-value", input: { path: "a" } },
          { id: "two", tool: "read-value", input: { path: "b" } },
        ],
      },
      context([reads], async () => {
        readCalls += 1;
        return { data: { value: 1 } };
      }),
    );
    const budgetData = budgeted.data as {
      status: string;
      budgetsConsumed: { toolCalls: { used: number }; exhausted: string };
    };
    expect(readCalls).toBe(1);
    expect(budgetData.status).toBe("budget-exhausted");
    expect(budgetData.budgetsConsumed).toMatchObject({
      toolCalls: { used: 1 },
      exhausted: "tool-calls",
    });

    let stepLimitedCalls = 0;
    const stepLimited = await execute(
      {
        goal: "respect a one step budget",
        mode: "execute",
        budgets: { maxSteps: 1, maxToolCalls: 10, timeoutMs: 10_000 },
        steps: [
          { id: "first-read", tool: "read-value", input: { path: "a" } },
          { id: "pending-read", tool: "read-value", input: { path: "b" } },
        ],
      },
      context([reads], async () => {
        stepLimitedCalls += 1;
        return { data: { value: 1 } };
      }),
    );
    const stepData = stepLimited.data as {
      status: string;
      budgetsConsumed: { steps: { used: number }; exhausted: string };
      continuationPlan: { pendingSteps: Array<{ id: string }> };
    };
    expect(stepLimitedCalls).toBe(1);
    expect(stepData.status).toBe("budget-exhausted");
    expect(stepData.budgetsConsumed).toMatchObject({ steps: { used: 1 }, exhausted: "steps" });
    expect(stepData.continuationPlan.pendingSteps).toContainEqual({
      id: "pending-read",
      tool: "read-value",
    });
  });

  it("stops waiting when the hard wall-clock budget expires", async () => {
    const slow = tool("slow-read", z.object({}));
    let calls = 0;
    const result = await execute(
      {
        goal: "bound a slow observation",
        mode: "execute",
        budgets: { maxSteps: 5, maxToolCalls: 5, timeoutMs: 100 },
        steps: [{ id: "slow", tool: "slow-read", input: {} }],
      },
      context([slow], () => {
        calls += 1;
        return new Promise<ToolResult>(() => undefined);
      }),
    );
    const data = result.data as {
      status: string;
      budgetsConsumed: { exhausted: string; timeMs: { remaining: number } };
    };
    expect(calls).toBe(1);
    expect(data.status).toBe("budget-exhausted");
    expect(data.budgetsConsumed.exhausted).toBe("time");
    expect(data.budgetsConsumed.timeMs.remaining).toBe(0);
  });
});
