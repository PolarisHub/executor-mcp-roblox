import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inferToolContract } from "../../../src/application/tool/tool-contract.js";
import type { ToolContext } from "../../../src/application/tool/tool.js";
import type {
  ToolDescriptor,
  ToolDirectory,
} from "../../../src/application/ports/tool-directory.js";
import {
  classifyFailure,
  type FailureClassificationInput,
  type RecoveryCause,
} from "../../../src/application/services/recovery-intelligence.js";
import explainFailure from "../../../src/tools/intelligence/explain-failure.js";

interface DescriptorOptions {
  readonly mutatesState?: boolean;
  readonly requiresClient?: boolean;
  readonly input?: z.ZodTypeAny;
  readonly alternatives?: readonly string[];
  readonly requiresCapabilities?: readonly string[];
  readonly failureRecovery?: readonly string[];
}

function descriptor(name: string, options: DescriptorOptions = {}): ToolDescriptor {
  const mutatesState = options.mutatesState ?? false;
  const requiresClient = options.requiresClient ?? false;
  const inferred = inferToolContract({
    name,
    category: "Utility",
    mutatesState,
    requiresClient,
  });
  return {
    name,
    title: name,
    description: `Test descriptor for ${name}.`,
    category: "Utility",
    mutatesState,
    requiresClient,
    input: options.input ?? z.object({}),
    ai: {
      ...inferred,
      alternatives: options.alternatives ?? inferred.alternatives,
      requiresCapabilities: options.requiresCapabilities ?? inferred.requiresCapabilities,
      failureRecovery: options.failureRecovery ?? inferred.failureRecovery,
    },
  };
}

function testDirectory(): ToolDirectory {
  const tools: ToolDescriptor[] = [
    descriptor("set-instance-property", {
      mutatesState: true,
      requiresClient: true,
      input: z.object({ path: z.string(), property: z.string(), value: z.unknown() }),
      alternatives: ["write-path-value"],
      failureRecovery: [
        "run verify-path-exists and search-instances before using a corrected reference",
      ],
    }),
    descriptor("click-button", {
      mutatesState: true,
      requiresClient: true,
      input: z.object({ path: z.string() }),
      alternatives: ["virtual-input"],
      requiresCapabilities: ["firesignal"],
      failureRecovery: ["run test-capabilities and use an alternative if unavailable"],
    }),
    descriptor("write-path-value", {
      mutatesState: true,
      requiresClient: true,
      input: z.object({ path: z.string(), value: z.unknown() }),
    }),
    descriptor("virtual-input", {
      mutatesState: true,
      requiresClient: true,
      input: z.object({ action: z.string() }),
      requiresCapabilities: ["VirtualInputManager"],
    }),
    descriptor("bridge-status"),
    descriptor("agent-context"),
    descriptor("list-clients"),
    descriptor("select-client", { input: z.object({ clientId: z.string() }) }),
    descriptor("get-active-client"),
    descriptor("search-instances", { requiresClient: true }),
    descriptor("verify-path-exists", {
      requiresClient: true,
      input: z.object({ path: z.string() }),
    }),
    descriptor("get-instance-tree", { requiresClient: true }),
    descriptor("test-capabilities", { requiresClient: true }),
    descriptor("get-executor-info", { requiresClient: true }),
    descriptor("discover-character", { requiresClient: true }),
    descriptor("get-local-player-info", { requiresClient: true }),
    descriptor("get-console-output", { requiresClient: true }),
    descriptor("script", { mutatesState: true, requiresClient: true }),
    descriptor("tool-schema"),
    descriptor("tool-plan"),
    descriptor("agent-run", { mutatesState: true }),
    descriptor("explain-failure"),
  ];
  return {
    list: () => tools,
    find: (name) => tools.find((tool) => tool.name === name) ?? null,
  };
}

const CLASSIFICATION_CASES: readonly {
  readonly label: string;
  readonly cause: RecoveryCause;
  readonly failure: Omit<FailureClassificationInput, "toolName">;
}[] = [
  {
    label: "transport disconnect",
    cause: "transport-disconnected",
    failure: { error: { code: "CLIENT_DISCONNECTED", message: "Transport closed" } },
  },
  {
    label: "missing client selection",
    cause: "no-client-selection",
    failure: { error: { code: "NO_CLIENT_SELECTED", message: "No active client selected" } },
  },
  {
    label: "ambiguous client selection",
    cause: "ambiguous-client-selection",
    failure: { error: { code: "AMBIGUOUS_CLIENT", message: "Multiple Roblox clients match" } },
  },
  {
    label: "stale instance path",
    cause: "stale-or-missing-instance-path",
    failure: { result: { error: "Path segment 'OldDoor' not found under 'Workspace'." } },
  },
  {
    label: "missing executor capability",
    cause: "missing-executor-capability",
    failure: { result: { error: "getgc is not available in this executor" } },
  },
  {
    label: "custom character hierarchy",
    cause: "custom-character-hierarchy",
    failure: {
      result: {
        characterRecovery: {
          status: "missing-or-custom",
          missing: ["Humanoid", "HumanoidRootPart"],
        },
      },
    },
  },
  {
    label: "timeout",
    cause: "timeout",
    failure: { error: { code: "EXECUTION_TIMEOUT", message: "Execution timed out" } },
  },
  {
    label: "invalid schema",
    cause: "invalid-schema-or-input",
    failure: { error: { code: "VALIDATION", message: "Invalid arguments: path is required" } },
  },
  {
    label: "blocked mutation",
    cause: "permission-or-mutation-blocked",
    failure: {
      result: { status: "blocked", reason: "Mutation not approved; allowMutations is false" },
    },
  },
  {
    label: "Luau runtime error",
    cause: "lua-runtime-error",
    failure: { error: { code: "EXECUTION_FAILED", message: "runtime error: attempt to call nil" } },
  },
  {
    label: "unsupported operation",
    cause: "unsupported-operation",
    failure: {
      error: { code: "TOOL_NOT_FOUND", message: "No tool named teleport-cat is registered" },
    },
  },
  {
    label: "unknown evidence",
    cause: "unknown",
    failure: { error: "The moon changed color unexpectedly." },
  },
];

describe("recovery intelligence", () => {
  it.each(CLASSIFICATION_CASES)("classifies $label deterministically", ({ cause, failure }) => {
    const first = classifyFailure(
      { toolName: "set-instance-property", attemptedInput: {}, ...failure },
      testDirectory(),
    );
    const second = classifyFailure(
      { toolName: "set-instance-property", attemptedInput: {}, ...failure },
      testDirectory(),
    );

    expect(first.cause).toBe(cause);
    expect(first).toEqual(second);
    expect(first.confidence).toBeGreaterThanOrEqual(0);
    expect(first.confidence).toBeLessThanOrEqual(1);
    expect(first.evidence.length).toBeGreaterThan(0);
    expect(first.recoverable).toBe(cause !== "unknown");
  });

  it("prioritizes live contract alternatives and omits tools requiring the failed capability", () => {
    const result = classifyFailure(
      {
        toolName: "click-button",
        error: "firesignal capability is missing in this executor",
        attemptedInput: { path: "Players.LocalPlayer.PlayerGui.Shop.Buy" },
      },
      testDirectory(),
    );

    expect(result.cause).toBe("missing-executor-capability");
    expect(result.fallbackTools[0]).toMatchObject({
      name: "virtual-input",
      score: 100,
      requiresCapabilities: ["VirtualInputManager"],
    });
    expect(result.fallbackTools.map((tool) => tool.name)).toContain("test-capabilities");
    expect(result.fallbackTools.map((tool) => tool.name)).not.toContain("click-button");
    expect(result.fallbackTools.every((tool) => tool.name !== "explain-failure")).toBe(true);
  });

  it("never permits or recommends repeating an identical failed mutation", () => {
    const result = classifyFailure(
      {
        toolName: "set-instance-property",
        error: { code: "EXECUTION_TIMEOUT", message: "Timed out after 20 seconds" },
        attemptedInput: { path: "Workspace.Door", property: "CanCollide", value: false },
      },
      testDirectory(),
    );

    expect(result.retryPolicy).toMatchObject({
      strategy: "after-state-check",
      maxAttempts: 0,
      retrySameInput: false,
    });
    expect(result.fallbackTools.map((tool) => tool.name)).not.toContain("set-instance-property");
    expect(result.nextActions.join(" ")).toContain(
      "Do not repeat set-instance-property with the same input",
    );
    expect(result.nextActions.join(" ")).toContain("may still have completed");
  });

  it("returns correctedInput only when the live schema validates a safely derived replacement", () => {
    const valid = classifyFailure(
      {
        toolName: "set-instance-property",
        result: { error: "Instance path not found" },
        attemptedInput: { path: "Workspace.OldDoor", property: "Transparency", value: 1 },
        context: { resolvedPath: "Workspace.Map.NewDoor" },
      },
      testDirectory(),
    );
    const invalid = classifyFailure(
      {
        toolName: "set-instance-property",
        error: "Invalid input schema",
        attemptedInput: { path: "Workspace.OldDoor", property: "Transparency", value: 1 },
        context: { correctedInput: { path: 42 } },
      },
      testDirectory(),
    );

    expect(valid.correctedInput).toEqual({
      path: "Workspace.Map.NewDoor",
      property: "Transparency",
      value: 1,
    });
    expect(invalid).not.toHaveProperty("correctedInput");
  });

  it("emits a recovery script only for a genuinely useful custom-character search", () => {
    const custom = classifyFailure(
      {
        toolName: "get-local-player-info",
        result: { characterRecovery: { status: "missing-or-custom" } },
      },
      testDirectory(),
    );
    const stale = classifyFailure(
      {
        toolName: "set-instance-property",
        result: { error: "Instance path not found" },
      },
      testDirectory(),
    );

    expect(custom.recoveryScript).toContain("HumanoidRootPart");
    expect(custom.recoveryScript).toContain("scanned < 1000");
    expect(stale).not.toHaveProperty("recoveryScript");
  });

  it("exposes explain-failure as a no-client read-only tool over the live directory", async () => {
    expect(explainFailure.requiresClient).toBe(false);
    expect(explainFailure.mutatesState).toBe(false);
    expect(explainFailure.category).toBe("Intelligence");

    const result = await explainFailure.execute(
      {
        toolName: "set-instance-property",
        error: "Mutation not approved",
        attemptedInput: { path: "Workspace.Door", property: "Transparency", value: 1 },
      },
      { tools: testDirectory() } as unknown as ToolContext,
    );
    const data = result.data as ReturnType<typeof classifyFailure>;

    expect(data.cause).toBe("permission-or-mutation-blocked");
    expect(data.fallbackTools.every((tool) => !tool.mutatesState)).toBe(true);
    expect(result.summary).toContain("permission-or-mutation-blocked");
  });
});
