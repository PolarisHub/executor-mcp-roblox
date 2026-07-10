import { z } from "zod";
import { describeInputFields, inputSignature } from "./schema-introspect.js";
import { matchWorkflows, rankTools } from "./tool-discovery.js";
import type { ToolDescriptor } from "../ports/tool-directory.js";
import type { ToolContext, ToolResult } from "../tool/tool.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Use a letter followed by letters, digits, _ or -.");

const assertionPathSchema = z
  .string()
  .min(1)
  .max(500)
  .describe("Live Instance path or an exact $steps reference resolving to one.");
const assertionMemberSchema = z.string().min(1).max(128);
const assertionScalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const assertionSelectorSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("class"), value: z.string().min(1).max(128) }),
  z.object({
    by: z.literal("name"),
    value: z.string().min(1).max(256),
    match: z.enum(["equals", "contains"]).optional().default("equals"),
    caseSensitive: z.boolean().optional().default(false),
  }),
  z.object({
    by: z.literal("text"),
    value: z.string().min(1).max(1_000),
    match: z.enum(["equals", "contains"]).optional().default("contains"),
    caseSensitive: z.boolean().optional().default(false),
  }),
]);

/** Kept wire-compatible with the live read-only assert-state tool. */
export const semanticAssertionSchema = z.discriminatedUnion("kind", [
  z.object({ id: identifierSchema, kind: z.literal("path-exists"), path: assertionPathSchema }),
  z.object({
    id: identifierSchema,
    kind: z.literal("path-not-exists"),
    path: assertionPathSchema,
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("property-equals"),
    path: assertionPathSchema,
    property: assertionMemberSchema,
    expected: assertionScalarSchema,
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("property-not-equals"),
    path: assertionPathSchema,
    property: assertionMemberSchema,
    expected: assertionScalarSchema,
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("property-contains"),
    path: assertionPathSchema,
    property: assertionMemberSchema,
    expected: z.string().max(2_000),
    caseSensitive: z.boolean().optional().default(false),
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("property-greater"),
    path: assertionPathSchema,
    property: assertionMemberSchema,
    expected: z.number().finite(),
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("property-less"),
    path: assertionPathSchema,
    property: assertionMemberSchema,
    expected: z.number().finite(),
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("attribute-equals"),
    path: assertionPathSchema,
    attribute: assertionMemberSchema,
    expected: assertionScalarSchema,
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("gui-visible"),
    path: assertionPathSchema,
    expected: z.boolean().optional().default(true),
    effective: z.boolean().optional().default(true),
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("gui-enabled"),
    path: assertionPathSchema,
    expected: z.boolean().optional().default(true),
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("descendant-exists"),
    path: assertionPathSchema,
    selector: assertionSelectorSchema,
    expected: z.boolean().optional().default(true),
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("character-distance"),
    targetPath: assertionPathSchema,
    operator: z.enum(["at-most", "at-least"]),
    distance: z.number().finite().nonnegative().max(1_000_000),
    playerName: z.string().min(1).max(64).optional(),
    characterPath: assertionPathSchema.optional(),
    rootPath: assertionPathSchema.optional(),
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("camera-facing"),
    targetPath: assertionPathSchema,
    maxAngleDegrees: z.number().finite().min(0).max(180).optional().default(10),
    cameraPath: assertionPathSchema.optional(),
  }),
  z.object({
    id: identifierSchema,
    kind: z.literal("collection-count"),
    path: assertionPathSchema,
    scope: z.enum(["children", "descendants"]).optional().default("children"),
    operator: z.enum(["equals", "not-equals", "greater", "less", "at-least", "at-most"]),
    count: z.number().int().nonnegative().max(1_000_000),
    selector: assertionSelectorSchema.optional(),
  }),
]);

export const adaptiveStepSchema = z.object({
  type: z
    .literal("tool")
    .optional()
    .default("tool")
    .describe("Typed step discriminator; smart-task currently executes registered tools."),
  id: identifierSchema.describe("Globally unique step identifier for $steps references."),
  phase: z
    .enum(["observe", "act", "verify"])
    .optional()
    .describe(
      "Declared intent used for preview auditing; the live tool contract remains authoritative.",
    ),
  tool: z.string().min(1).max(128).describe("Exact registered tool name."),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe(
      "Typed tool input; exact values may reference prior results with $steps.<id>.<path>.",
    ),
  assertions: z
    .array(semanticAssertionSchema)
    .max(20)
    .optional()
    .default([])
    .describe("Semantic postconditions verified by the read-only assert-state tool."),
  recoverWith: z
    .array(identifierSchema)
    .max(8)
    .optional()
    .default([])
    .describe("Ordered, explicitly declared fallback branch IDs. No implicit retry occurs."),
  onFailure: z
    .enum(["stop", "continue"])
    .optional()
    .default("stop")
    .describe("Behavior after declared recovery branches are exhausted."),
});

export const fallbackBranchSchema = z.object({
  id: identifierSchema.describe("Unique branch identifier referenced by recoverWith."),
  when: z
    .enum(["tool-error", "assertion-failed", "blocked", "any"])
    .optional()
    .default("any")
    .describe("Failure class this branch is allowed to handle."),
  steps: z
    .array(adaptiveStepSchema)
    .min(1)
    .max(30)
    .describe("Explicit alternative steps; branches are used at most once per run."),
  resolvesAssertions: z
    .array(identifierSchema)
    .max(20)
    .optional()
    .default([])
    .describe("Failed assertion IDs to re-run after this branch succeeds."),
  resume: z
    .enum(["next", "stop"])
    .optional()
    .default("next")
    .describe("Resume the interrupted sequence or intentionally stop after recovery."),
});

export const adaptiveBudgetsSchema = z.object({
  maxSteps: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(20)
    .describe("Hard cap across main and fallback steps."),
  maxToolCalls: z
    .number()
    .int()
    .positive()
    .max(250)
    .optional()
    .default(40)
    .describe("Hard cap including actions, assert-state, and explain-failure calls."),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(600_000)
    .optional()
    .default(60_000)
    .describe("Hard wall-clock budget for the complete task."),
});

export const adaptiveWorkflowInputSchema = z.object({
  goal: z.string().min(3).max(2_000).describe("Concrete outcome the workflow must prove."),
  mode: z
    .enum(["plan", "preview", "execute"])
    .optional()
    .default("plan")
    .describe("Plan ranks tools, preview validates explicit steps, and execute invokes tools."),
  steps: z
    .array(adaptiveStepSchema)
    .max(100)
    .optional()
    .describe("Explicit ordered workflow. Omit it for deterministic schema-aware planning."),
  fallbacks: z
    .array(fallbackBranchSchema)
    .max(30)
    .optional()
    .default([])
    .describe("Named recovery branches; only a step's recoverWith list can activate one."),
  successAssertions: z
    .array(semanticAssertionSchema)
    .max(30)
    .optional()
    .default([])
    .describe("Goal-level assertions evaluated after the main workflow."),
  finalRecoverWith: z
    .array(identifierSchema)
    .max(8)
    .optional()
    .default([])
    .describe("Explicit branches available if goal-level assertions fail."),
  allowMutations: z
    .boolean()
    .optional()
    .default(false)
    .describe("User approval gate for every tool whose contract mutates state."),
  budgets: adaptiveBudgetsSchema
    .optional()
    .default({ maxSteps: 20, maxToolCalls: 40, timeoutMs: 60_000 }),
});

export type SemanticAssertion = z.infer<typeof semanticAssertionSchema>;
export type AdaptiveStep = z.infer<typeof adaptiveStepSchema>;
export type FallbackBranch = z.infer<typeof fallbackBranchSchema>;
export type AdaptiveWorkflowInput = z.infer<typeof adaptiveWorkflowInputSchema>;

interface ValidationIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly stepId?: string;
  readonly branchId?: string;
}

type FailureKind = "tool-error" | "assertion-failed" | "blocked" | "budget" | "loop";

interface FailureInfo {
  readonly kind: FailureKind;
  readonly message: string;
  readonly assertionIds: readonly string[];
  readonly result?: unknown;
}

interface FailureRecord {
  readonly stepId: string;
  readonly tool: string;
  readonly kind: FailureKind;
  readonly message: string;
  readonly assertionIds: readonly string[];
  recovered: boolean;
  recoveryBranch?: string;
  explanation?: unknown;
}

interface AssertionState {
  readonly id: string;
  readonly stepId: string;
  readonly assertion: SemanticAssertion;
  readonly passed: boolean | null;
  readonly reason: string;
  readonly evidence?: unknown;
}

interface EvidenceEvent {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly kind: "step" | "assertion" | "diagnosis" | "fallback" | "budget" | "loop";
  readonly status: string;
  readonly stepId?: string;
  readonly branchId?: string;
  readonly tool?: string;
  readonly message?: string;
  readonly evidence?: unknown;
}

interface RuntimeState {
  readonly input: AdaptiveWorkflowInput;
  readonly ctx: ToolContext;
  readonly catalog: ReadonlyMap<string, ToolDescriptor>;
  readonly branches: ReadonlyMap<string, FallbackBranch>;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly outputs: Map<string, unknown>;
  readonly evidence: EvidenceEvent[];
  readonly failures: FailureRecord[];
  readonly assertions: Map<string, AssertionState>;
  readonly resolvedAssertions: Map<string, SemanticAssertion>;
  readonly signatures: Map<string, number>;
  readonly usedBranches: Set<string>;
  readonly executedStepIds: Set<string>;
  readonly recoveryRecommendations: string[];
  stepsUsed: number;
  successfulSteps: number;
  toolCallsUsed: number;
  budgetStop: "steps" | "tool-calls" | "time" | "aborted" | null;
  intentionallyStopped: boolean;
}

interface SequenceResult {
  readonly reachedEnd: boolean;
  readonly hadUnrecoveredFailure: boolean;
  readonly stopRequested: boolean;
}

interface StepOutcome {
  readonly ok: boolean;
  readonly failure?: FailureInfo;
  readonly resolvedInput?: unknown;
}

class BudgetExceeded extends Error {
  constructor(readonly budget: "steps" | "tool-calls" | "time" | "aborted") {
    super(`Adaptive workflow ${budget} budget exhausted.`);
  }
}

const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);
const STEP_REFERENCE =
  /^\$steps\.([A-Za-z][A-Za-z0-9_-]*)(?:\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasReference(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.startsWith("$steps.");
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => hasReference(entry, seen));
  return Object.values(value).some((entry) => hasReference(entry, seen));
}

function readPath(root: unknown, path: string | undefined, reference: string): unknown {
  if (!path) return root;
  let current = root;
  for (const part of path.split(".")) {
    if (FORBIDDEN_PATH_PARTS.has(part)) {
      throw new Error(`Unsafe step reference path in "${reference}".`);
    }
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      const index = Number(part);
      if (index >= current.length) throw new Error(`Missing step reference "${reference}".`);
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      throw new Error(`Missing step reference "${reference}".`);
    }
    current = current[part];
  }
  if (current === undefined) throw new Error(`Missing step reference "${reference}".`);
  return current;
}

export function resolveStepReferences(
  value: unknown,
  outputs: ReadonlyMap<string, unknown>,
): unknown {
  const seen = new WeakSet<object>();
  const counter = { nodes: 0 };
  const visit = (entry: unknown, depth: number): unknown => {
    counter.nodes += 1;
    if (depth > 40 || counter.nodes > 20_000) {
      throw new Error("Step reference input exceeds the safe traversal limit.");
    }
    if (typeof entry === "string") {
      if (!entry.startsWith("$steps.")) return entry;
      const match = STEP_REFERENCE.exec(entry);
      if (!match) throw new Error(`Malformed step reference "${entry}".`);
      const root = outputs.get(match[1]!);
      if (root === undefined) throw new Error(`Unknown or not-yet-executed step "${match[1]}".`);
      return readPath(root, match[2], entry);
    }
    if (entry === null || typeof entry !== "object") return entry;
    if (seen.has(entry)) throw new Error("Cyclic values are not valid workflow inputs.");
    seen.add(entry);
    let resolved: unknown;
    if (Array.isArray(entry)) {
      resolved = entry.map((item) => visit(item, depth + 1));
    } else {
      const record: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(entry)) {
        if (FORBIDDEN_PATH_PARTS.has(key)) throw new Error(`Unsafe input key "${key}".`);
        record[key] = visit(child, depth + 1);
      }
      resolved = record;
    }
    seen.delete(entry);
    return resolved;
  };
  return visit(value, 0);
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return "[undefined]";
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry, seen)]),
  );
}

function actionSignature(tool: string, input: unknown): string {
  return `${tool}:${JSON.stringify(canonicalize(input))}`;
}

function evidenceSnapshot(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "[truncated]";
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => evidenceSnapshot(entry, depth + 1, seen));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 30)
      .map(([key, entry]) => [key, evidenceSnapshot(entry, depth + 1, seen)]),
  );
}

function pushEvidence(
  state: RuntimeState,
  event: Omit<EvidenceEvent, "sequence" | "elapsedMs">,
): void {
  state.evidence.push({
    sequence: state.evidence.length + 1,
    elapsedMs: Math.max(0, Date.now() - state.startedAt),
    ...event,
  });
}

function addRecommendation(state: RuntimeState, value: string): void {
  const trimmed = value.trim();
  if (trimmed && !state.recoveryRecommendations.includes(trimmed)) {
    state.recoveryRecommendations.push(trimmed);
  }
}

function describeTool(tool: ToolDescriptor) {
  const args = describeInputFields(tool.input);
  const requiredArguments = args.filter((field) => !field.optional).map((field) => field.name);
  return {
    name: tool.name,
    title: tool.title,
    category: tool.category,
    signature: inputSignature(tool.input),
    arguments: args,
    requiredArguments,
    input: requiredArguments.length === 0 ? {} : null,
    readyWithoutArguments: requiredArguments.length === 0,
    mutatesState: tool.mutatesState,
    requiresClient: tool.requiresClient,
    ai: tool.ai,
  };
}

function schemaAwarePlan(
  goal: string,
  catalog: readonly ToolDescriptor[],
  allowMutations: boolean,
) {
  const available = new Set(catalog.map((tool) => tool.name));
  const workflows = matchWorkflows(goal, available).map((workflow) => ({
    id: workflow.id,
    title: workflow.title,
    description: workflow.description,
    steps: workflow.steps.flatMap((step, index) => {
      const tool = catalog.find((candidate) => candidate.name === step.tool);
      return tool
        ? [
            {
              order: index + 1,
              phase: step.phase,
              why: step.why,
              ...describeTool(tool),
              blocked: tool.mutatesState && !allowMutations,
            },
          ]
        : [];
    }),
  }));
  const alternatives = rankTools(goal, catalog, 12).map((entry) => ({
    ...describeTool(entry.tool),
    score: Math.round(entry.score * 10) / 10,
    matchedTerms: entry.matchedTerms,
    why: entry.why,
    blocked: entry.tool.mutatesState && !allowMutations,
  }));
  const required = [...workflows.flatMap((workflow) => workflow.steps), ...alternatives]
    .filter((entry) => entry.requiredArguments.length > 0)
    .map((entry) => ({ tool: entry.name, requiredArguments: entry.requiredArguments }));
  return {
    strategy: "Deterministic lexical ranking plus curated workflows; no LLM or argument invention.",
    workflows,
    alternatives,
    missingRequiredArguments: required,
    continuationPlan: required.length
      ? [
          "Choose a workflow or ranked tool.",
          "Resolve every listed required argument from observation output or tool-schema.",
          "Submit explicit typed steps in preview mode before execute mode.",
        ]
      : ["Choose a workflow or ranked tool, then submit explicit typed steps in preview mode."],
  };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

function validateExplicitWorkflow(
  input: AdaptiveWorkflowInput,
  catalog: ReadonlyMap<string, ToolDescriptor>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const branchIds = new Set<string>();
  for (const branch of input.fallbacks) {
    if (branchIds.has(branch.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-branch-id",
        branchId: branch.id,
        message: `Fallback branch "${branch.id}" is declared more than once.`,
      });
    }
    branchIds.add(branch.id);
  }
  const steps = [
    ...(input.steps ?? []).map((step) => ({ step, branchId: undefined as string | undefined })),
    ...input.fallbacks.flatMap((branch) =>
      branch.steps.map((step) => ({ step, branchId: branch.id })),
    ),
  ];
  const stepIds = new Set<string>();
  const assertionIds = new Set<string>();
  for (const { step, branchId } of steps) {
    if (stepIds.has(step.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-step-id",
        stepId: step.id,
        branchId,
        message: `Step "${step.id}" must be globally unique, including fallback branches.`,
      });
    }
    stepIds.add(step.id);
    const tool = catalog.get(step.tool);
    if (!tool) {
      issues.push({
        severity: "error",
        code: "unknown-tool",
        stepId: step.id,
        branchId,
        message: `Tool "${step.tool}" is not registered.`,
      });
    } else {
      if (tool.mutatesState && !input.allowMutations) {
        issues.push({
          severity: "warning",
          code: "mutation-not-approved",
          stepId: step.id,
          branchId,
          message: `Step "${step.id}" is blocked until allowMutations=true.`,
        });
      }
      if (step.phase && tool.ai?.phase && step.phase !== tool.ai.phase) {
        issues.push({
          severity: "warning",
          code: "phase-mismatch",
          stepId: step.id,
          branchId,
          message: `Declared phase "${step.phase}" differs from ${step.tool}'s "${tool.ai.phase}" contract.`,
        });
      }
      if (!hasReference(step.input)) {
        const parsed = tool.input.safeParse(step.input);
        if (!parsed.success) {
          issues.push({
            severity: "error",
            code: "invalid-input",
            stepId: step.id,
            branchId,
            message: formatZodError(parsed.error),
          });
        }
      }
    }
    for (const branchName of step.recoverWith) {
      if (!branchIds.has(branchName)) {
        issues.push({
          severity: "error",
          code: "unknown-fallback",
          stepId: step.id,
          branchId,
          message: `recoverWith references undeclared branch "${branchName}".`,
        });
      }
    }
    for (const assertion of step.assertions) {
      if (assertionIds.has(assertion.id)) {
        issues.push({
          severity: "error",
          code: "duplicate-assertion-id",
          stepId: step.id,
          branchId,
          message: `Assertion "${assertion.id}" must be globally unique.`,
        });
      }
      assertionIds.add(assertion.id);
    }
  }
  for (const assertion of input.successAssertions) {
    if (assertionIds.has(assertion.id)) {
      issues.push({
        severity: "error",
        code: "duplicate-assertion-id",
        message: `Assertion "${assertion.id}" must be globally unique.`,
      });
    }
    assertionIds.add(assertion.id);
  }
  for (const branchName of input.finalRecoverWith) {
    if (!branchIds.has(branchName)) {
      issues.push({
        severity: "error",
        code: "unknown-fallback",
        message: `finalRecoverWith references undeclared branch "${branchName}".`,
      });
    }
  }
  for (const branch of input.fallbacks) {
    for (const assertionId of branch.resolvesAssertions) {
      if (!assertionIds.has(assertionId)) {
        issues.push({
          severity: "error",
          code: "unknown-assertion",
          branchId: branch.id,
          message: `Branch "${branch.id}" cannot recheck unknown assertion "${assertionId}".`,
        });
      }
    }
  }
  const allAssertions =
    input.successAssertions.length +
    steps.reduce((sum, entry) => sum + entry.step.assertions.length, 0);
  if (allAssertions > 0) {
    const assertionTool = catalog.get("assert-state");
    if (!assertionTool) {
      issues.push({
        severity: "error",
        code: "assert-state-unavailable",
        message: "Assertions require the registered read-only assert-state tool before execution.",
      });
    } else if (assertionTool.mutatesState) {
      issues.push({
        severity: "error",
        code: "assert-state-mutates",
        message: "assert-state must be read-only and cannot be used as registered.",
      });
    }
  }
  if ((input.steps?.length ?? 0) > input.budgets.maxSteps) {
    issues.push({
      severity: "warning",
      code: "main-plan-exceeds-step-budget",
      message: `The main plan has ${input.steps?.length ?? 0} steps but maxSteps is ${input.budgets.maxSteps}.`,
    });
  }
  return issues;
}

function previewSteps(input: AdaptiveWorkflowInput, catalog: ReadonlyMap<string, ToolDescriptor>) {
  const describeStep = (step: AdaptiveStep) => {
    const tool = catalog.get(step.tool);
    const deferred = hasReference(step.input);
    return {
      id: step.id,
      type: step.type,
      phase: step.phase ?? tool?.ai?.phase ?? (tool?.mutatesState ? "act" : "observe"),
      tool: step.tool,
      known: tool !== undefined,
      mutatesState: tool?.mutatesState ?? null,
      mutationApproved: !tool?.mutatesState || input.allowMutations,
      signature: tool ? inputSignature(tool.input) : null,
      arguments: tool ? describeInputFields(tool.input) : [],
      schemaValidation: deferred ? "deferred-until-references-resolve" : "checked",
      assertions: step.assertions.map((assertion) => assertion.id),
      recoverWith: step.recoverWith,
      onFailure: step.onFailure,
    };
  };
  return {
    main: (input.steps ?? []).map(describeStep),
    fallbacks: input.fallbacks.map((branch) => ({
      id: branch.id,
      when: branch.when,
      resume: branch.resume,
      resolvesAssertions: branch.resolvesAssertions,
      steps: branch.steps.map(describeStep),
    })),
  };
}

function checkTime(state: RuntimeState): void {
  if (state.ctx.signal.aborted) {
    state.budgetStop = "aborted";
    throw new BudgetExceeded("aborted");
  }
  if (Date.now() >= state.deadlineAt) {
    state.budgetStop = "time";
    throw new BudgetExceeded("time");
  }
}

function reserveStep(state: RuntimeState): void {
  checkTime(state);
  if (state.stepsUsed >= state.input.budgets.maxSteps) {
    state.budgetStop = "steps";
    throw new BudgetExceeded("steps");
  }
  state.stepsUsed += 1;
}

async function invokeBudgeted(
  state: RuntimeState,
  name: string,
  input: unknown,
): Promise<ToolResult> {
  checkTime(state);
  if (state.toolCallsUsed >= state.input.budgets.maxToolCalls) {
    state.budgetStop = "tool-calls";
    throw new BudgetExceeded("tool-calls");
  }
  state.toolCallsUsed += 1;
  const remainingMs = state.deadlineAt - Date.now();
  const pending = state.ctx.invokeTool(name, input);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<ToolResult>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            state.budgetStop = "time";
            reject(new BudgetExceeded("time"));
          },
          Math.max(1, remainingMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function explicitTruth(value: unknown): boolean | null {
  if (!isRecord(value)) return null;
  for (const key of ["passed", "satisfied", "truth"] as const) {
    if (typeof value[key] === "boolean") return value[key];
  }
  return null;
}

function assertionTruth(
  data: unknown,
  assertions: readonly SemanticAssertion[],
): { id: string; passed: boolean | null; evidence?: unknown }[] {
  const record = isRecord(data) ? data : null;
  const rootTruth =
    record && typeof record["allPassed"] === "boolean"
      ? record["allPassed"]
      : record && typeof record["passed"] === "boolean"
        ? record["passed"]
        : record &&
            isRecord(record["aggregate"]) &&
            typeof record["aggregate"]["passed"] === "boolean"
          ? record["aggregate"]["passed"]
          : record && typeof record["satisfied"] === "boolean"
            ? record["satisfied"]
            : record && typeof record["truth"] === "boolean"
              ? record["truth"]
              : null;
  const candidateList = record
    ? (["assertions", "results", "checks"] as const)
        .map((key) => record[key])
        .find((value): value is unknown[] => Array.isArray(value))
    : undefined;
  return assertions.map((assertion, index) => {
    const byId = candidateList?.find((entry) => isRecord(entry) && entry["id"] === assertion.id);
    const candidate = byId ?? candidateList?.[index];
    return {
      id: assertion.id,
      passed: explicitTruth(candidate) ?? rootTruth,
      ...(candidate === undefined ? {} : { evidence: evidenceSnapshot(candidate) }),
    };
  });
}

async function runAssertions(
  state: RuntimeState,
  stepId: string,
  assertions: readonly SemanticAssertion[],
  reason: "post-step" | "goal" | "recovery-recheck",
): Promise<FailureInfo | null> {
  if (assertions.length === 0) return null;
  let resolved: SemanticAssertion[];
  try {
    resolved = assertions.map(
      (assertion) => resolveStepReferences(assertion, state.outputs) as SemanticAssertion,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const assertion of assertions) {
      state.assertions.set(assertion.id, {
        id: assertion.id,
        stepId,
        assertion,
        passed: null,
        reason: message,
      });
    }
    pushEvidence(state, {
      kind: "assertion",
      status: "unresolved",
      stepId,
      message,
    });
    return { kind: "assertion-failed", message, assertionIds: assertions.map(({ id }) => id) };
  }
  for (const assertion of resolved) state.resolvedAssertions.set(assertion.id, assertion);
  const descriptor = state.catalog.get("assert-state");
  if (!descriptor || descriptor.mutatesState) {
    const message = !descriptor
      ? "Read-only assert-state is not registered; call success cannot verify semantic truth."
      : "assert-state is marked mutating and was refused as a verifier.";
    for (const assertion of resolved) {
      state.assertions.set(assertion.id, {
        id: assertion.id,
        stepId,
        assertion,
        passed: null,
        reason: message,
      });
    }
    pushEvidence(state, {
      kind: "assertion",
      status: "unavailable",
      stepId,
      tool: "assert-state",
      message,
    });
    addRecommendation(state, message);
    return { kind: "assertion-failed", message, assertionIds: resolved.map(({ id }) => id) };
  }
  let result: ToolResult;
  try {
    result = await invokeBudgeted(state, "assert-state", {
      goal: state.input.goal,
      reason,
      stepId,
      assertions: resolved,
      references: Object.fromEntries(state.outputs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind: FailureKind = error instanceof BudgetExceeded ? "budget" : "assertion-failed";
    for (const assertion of resolved) {
      state.assertions.set(assertion.id, {
        id: assertion.id,
        stepId,
        assertion,
        passed: null,
        reason: message,
      });
    }
    pushEvidence(state, {
      kind: error instanceof BudgetExceeded ? "budget" : "assertion",
      status: "failed",
      stepId,
      tool: "assert-state",
      message,
    });
    return { kind, message, assertionIds: resolved.map(({ id }) => id) };
  }
  const truth = assertionTruth(result.data, resolved);
  const unresolvedIds: string[] = [];
  for (const item of truth) {
    const assertion = resolved.find((candidate) => candidate.id === item.id)!;
    const passed = result.isError ? false : item.passed;
    const reasonText = result.isError
      ? "assert-state returned a handled error."
      : passed === null
        ? "assert-state returned no explicit boolean truth; tool-call success is not verification."
        : passed
          ? "assert-state explicitly reported true."
          : "assert-state explicitly reported false.";
    state.assertions.set(item.id, {
      id: item.id,
      stepId,
      assertion,
      passed,
      reason: reasonText,
      ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
    });
    if (passed !== true) unresolvedIds.push(item.id);
  }
  pushEvidence(state, {
    kind: "assertion",
    status: unresolvedIds.length === 0 ? "passed" : "failed",
    stepId,
    tool: "assert-state",
    message:
      unresolvedIds.length === 0
        ? `${resolved.length} semantic assertion(s) explicitly passed.`
        : `${unresolvedIds.length}/${resolved.length} semantic assertion(s) are false or unresolved.`,
    evidence: evidenceSnapshot(result.data),
  });
  return unresolvedIds.length === 0
    ? null
    : {
        kind: "assertion-failed",
        message: `Semantic assertions failed or were indeterminate: ${unresolvedIds.join(", ")}.`,
        assertionIds: unresolvedIds,
        result: result.data,
      };
}

function extractRecommendations(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const recommendations: string[] = [];
  for (const key of ["recommendations", "recoveryRecommendations", "nextActions"] as const) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      for (const entry of candidate) if (typeof entry === "string") recommendations.push(entry);
    }
  }
  for (const key of ["recommendation", "next"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string") recommendations.push(candidate);
  }
  return recommendations;
}

async function explainFailure(
  state: RuntimeState,
  step: AdaptiveStep,
  failure: FailureInfo,
  resolvedInput: unknown,
): Promise<unknown> {
  const descriptor = state.catalog.get("explain-failure");
  if (!descriptor) return undefined;
  if (descriptor.mutatesState) {
    addRecommendation(state, "explain-failure is registered as mutating and was not invoked.");
    return undefined;
  }
  try {
    const result = await invokeBudgeted(state, "explain-failure", {
      toolName: step.tool,
      error: failure.message,
      result: failure.result,
      attemptedInput: resolvedInput,
      context: {
        goal: state.input.goal,
        stepId: step.id,
        failureKind: failure.kind,
        assertionIds: failure.assertionIds,
        recoverWith: step.recoverWith,
      },
    });
    pushEvidence(state, {
      kind: "diagnosis",
      status: result.isError ? "failed" : "explained",
      stepId: step.id,
      tool: "explain-failure",
      evidence: evidenceSnapshot(result.data),
    });
    for (const recommendation of extractRecommendations(result.data)) {
      addRecommendation(state, recommendation);
    }
    return result.data;
  } catch (error) {
    pushEvidence(state, {
      kind: error instanceof BudgetExceeded ? "budget" : "diagnosis",
      status: "failed",
      stepId: step.id,
      tool: "explain-failure",
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function matchesBranch(branch: FallbackBranch, kind: FailureKind): boolean {
  if (branch.when === "any") return true;
  if (branch.when === "blocked") return kind === "blocked" || kind === "loop";
  return branch.when === kind;
}

function selectBranch(
  state: RuntimeState,
  step: AdaptiveStep,
  kind: FailureKind,
): FallbackBranch | null {
  for (const id of step.recoverWith) {
    const branch = state.branches.get(id);
    if (branch && !state.usedBranches.has(id) && matchesBranch(branch, kind)) return branch;
  }
  return null;
}

async function executeStep(
  state: RuntimeState,
  step: AdaptiveStep,
  branchId: string | undefined,
): Promise<StepOutcome> {
  try {
    reserveStep(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushEvidence(state, {
      kind: "budget",
      status: "exhausted",
      stepId: step.id,
      branchId,
      message,
    });
    return { ok: false, failure: { kind: "budget", message, assertionIds: [] } };
  }
  state.executedStepIds.add(step.id);
  const descriptor = state.catalog.get(step.tool);
  if (!descriptor) {
    return {
      ok: false,
      failure: {
        kind: "tool-error",
        message: `Unknown tool "${step.tool}".`,
        assertionIds: [],
      },
    };
  }
  if (descriptor.mutatesState && !state.input.allowMutations) {
    const message =
      "Mutation approval is absent; set allowMutations=true only with user authorization.";
    pushEvidence(state, {
      kind: "step",
      status: "blocked",
      stepId: step.id,
      branchId,
      tool: step.tool,
      message,
    });
    return { ok: false, failure: { kind: "blocked", message, assertionIds: [] } };
  }
  let resolvedInput: unknown;
  try {
    resolvedInput = resolveStepReferences(step.input, state.outputs);
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "tool-error",
        message: error instanceof Error ? error.message : String(error),
        assertionIds: [],
      },
    };
  }
  const parsed = descriptor.input.safeParse(resolvedInput);
  if (!parsed.success) {
    return {
      ok: false,
      resolvedInput,
      failure: {
        kind: "tool-error",
        message: `Input does not match ${step.tool}: ${formatZodError(parsed.error)}`,
        assertionIds: [],
      },
    };
  }
  resolvedInput = parsed.data;
  const signature = actionSignature(step.tool, resolvedInput);
  const repeats = state.signatures.get(signature) ?? 0;
  if ((descriptor.mutatesState && repeats >= 1) || (!descriptor.mutatesState && repeats >= 2)) {
    const message = descriptor.mutatesState
      ? "Refused an identical mutating action; smart-task never blindly repeats a mutation."
      : "Repeated action and input signature indicates a loop.";
    pushEvidence(state, {
      kind: "loop",
      status: "blocked",
      stepId: step.id,
      branchId,
      tool: step.tool,
      message,
      evidence: { signature, previousCalls: repeats },
    });
    addRecommendation(state, message);
    return { ok: false, resolvedInput, failure: { kind: "loop", message, assertionIds: [] } };
  }
  state.signatures.set(signature, repeats + 1);
  let result: ToolResult;
  try {
    result = await invokeBudgeted(state, step.tool, resolvedInput);
  } catch (error) {
    const budget = error instanceof BudgetExceeded;
    const message = error instanceof Error ? error.message : String(error);
    if (budget && descriptor.mutatesState) {
      addRecommendation(
        state,
        `Verify ${step.tool}'s intended postcondition before any later action; a timed-out mutation may still complete.`,
      );
    }
    pushEvidence(state, {
      kind: budget ? "budget" : "step",
      status: budget ? "exhausted" : "threw",
      stepId: step.id,
      branchId,
      tool: step.tool,
      message,
    });
    return {
      ok: false,
      resolvedInput,
      failure: { kind: budget ? "budget" : "tool-error", message, assertionIds: [] },
    };
  }
  state.outputs.set(step.id, {
    data: result.data,
    result: result.data,
    summary: result.summary,
    isError: result.isError ?? false,
  });
  pushEvidence(state, {
    kind: "step",
    status: result.isError ? "handled-error" : "succeeded",
    stepId: step.id,
    branchId,
    tool: step.tool,
    ...(result.summary ? { message: result.summary } : {}),
    evidence: evidenceSnapshot(result.data),
  });
  if (result.isError) {
    return {
      ok: false,
      resolvedInput,
      failure: {
        kind: "tool-error",
        message: result.summary ?? `${step.tool} returned a handled error.`,
        assertionIds: [],
        result: result.data,
      },
    };
  }
  const assertionFailure = await runAssertions(state, step.id, step.assertions, "post-step");
  if (assertionFailure) return { ok: false, resolvedInput, failure: assertionFailure };
  state.successfulSteps += 1;
  return { ok: true, resolvedInput };
}

async function executeSequence(
  state: RuntimeState,
  steps: readonly AdaptiveStep[],
  branchId?: string,
): Promise<SequenceResult> {
  let hadUnrecoveredFailure = false;
  for (const step of steps) {
    const outcome = await executeStep(state, step, branchId);
    if (outcome.ok) continue;
    const failure = outcome.failure!;
    const record: FailureRecord = {
      stepId: step.id,
      tool: step.tool,
      kind: failure.kind,
      message: failure.message,
      assertionIds: failure.assertionIds,
      recovered: false,
    };
    state.failures.push(record);
    const descriptor = state.catalog.get(step.tool);
    for (const recommendation of descriptor?.ai?.failureRecovery ?? []) {
      addRecommendation(state, recommendation);
    }
    if (failure.kind === "tool-error" || failure.kind === "assertion-failed") {
      record.explanation = await explainFailure(state, step, failure, outcome.resolvedInput);
    }
    const fallback = selectBranch(state, step, failure.kind);
    if (fallback && !state.budgetStop) {
      state.usedBranches.add(fallback.id);
      record.recoveryBranch = fallback.id;
      pushEvidence(state, {
        kind: "fallback",
        status: "selected",
        stepId: step.id,
        branchId: fallback.id,
        message: `Selected explicit ${fallback.when} recovery branch.`,
      });
      const branchResult = await executeSequence(state, fallback.steps, fallback.id);
      let assertionsRecovered = failure.assertionIds.length === 0;
      if (
        branchResult.reachedEnd &&
        !branchResult.hadUnrecoveredFailure &&
        failure.assertionIds.length > 0
      ) {
        const recheckIds = failure.assertionIds.filter((id) =>
          fallback.resolvesAssertions.includes(id),
        );
        const recheckAssertions = recheckIds.flatMap((id) => {
          const assertion = state.resolvedAssertions.get(id);
          return assertion ? [assertion] : [];
        });
        if (recheckAssertions.length === failure.assertionIds.length) {
          const recheck = await runAssertions(
            state,
            step.id,
            recheckAssertions,
            "recovery-recheck",
          );
          assertionsRecovered = recheck === null;
        }
      }
      if (branchResult.reachedEnd && !branchResult.hadUnrecoveredFailure && assertionsRecovered) {
        record.recovered = true;
        pushEvidence(state, {
          kind: "fallback",
          status: "recovered",
          stepId: step.id,
          branchId: fallback.id,
          message: "Fallback completed and required assertions were explicitly rechecked.",
        });
        if (fallback.resume === "stop" || branchResult.stopRequested) {
          state.intentionallyStopped = true;
          return { reachedEnd: false, hadUnrecoveredFailure, stopRequested: true };
        }
        continue;
      }
      hadUnrecoveredFailure = true;
    } else {
      hadUnrecoveredFailure = true;
    }
    if (state.budgetStop || step.onFailure === "stop") {
      return { reachedEnd: false, hadUnrecoveredFailure: true, stopRequested: true };
    }
  }
  return { reachedEnd: true, hadUnrecoveredFailure, stopRequested: false };
}

function confidenceFor(state: RuntimeState, status: string) {
  const assertionStates = [...state.assertions.values()];
  const assertionTotal = assertionStates.length;
  const assertionPassed = assertionStates.filter((entry) => entry.passed === true).length;
  const assertionRatio = assertionTotal === 0 ? null : assertionPassed / assertionTotal;
  const stepRatio = state.stepsUsed === 0 ? 0 : state.successfulSteps / state.stepsUsed;
  let score: number;
  if (status === "completed" && assertionTotal > 0 && assertionPassed === assertionTotal) {
    score = 0.98;
  } else if (status === "completed") {
    score = 0.65;
  } else if (assertionRatio === null) {
    score = Math.min(0.5, stepRatio * 0.5);
  } else {
    score = Math.min(0.85, assertionRatio * 0.65 + stepRatio * 0.2);
  }
  const rounded = Math.round(score * 100) / 100;
  return {
    score: rounded,
    level: rounded >= 0.9 ? "high" : rounded >= 0.6 ? "medium" : "low",
    basis:
      assertionTotal === 0
        ? "No semantic assertions were supplied; successful calls alone cap confidence at 0.65."
        : `${assertionPassed}/${assertionTotal} assertions explicitly reported true; ${state.successfulSteps}/${state.stepsUsed} steps succeeded.`,
  };
}

function consumedBudgets(state: RuntimeState) {
  const elapsed = Math.max(0, Date.now() - state.startedAt);
  return {
    steps: {
      used: state.stepsUsed,
      limit: state.input.budgets.maxSteps,
      remaining: Math.max(0, state.input.budgets.maxSteps - state.stepsUsed),
    },
    toolCalls: {
      used: state.toolCallsUsed,
      limit: state.input.budgets.maxToolCalls,
      remaining: Math.max(0, state.input.budgets.maxToolCalls - state.toolCallsUsed),
    },
    timeMs: {
      used: Math.min(elapsed, state.input.budgets.timeoutMs),
      limit: state.input.budgets.timeoutMs,
      remaining: Math.max(0, state.input.budgets.timeoutMs - elapsed),
    },
    exhausted: state.budgetStop,
  };
}

function buildContinuation(
  state: RuntimeState,
  mainSteps: readonly AdaptiveStep[],
  unresolved: readonly AssertionState[],
) {
  const pendingSteps = mainSteps
    .filter((step) => !state.executedStepIds.has(step.id))
    .map((step) => ({ id: step.id, tool: step.tool }));
  const failedSteps = state.failures
    .filter((failure) => !failure.recovered)
    .map((failure) => ({
      id: failure.stepId,
      tool: failure.tool,
      kind: failure.kind,
      message: failure.message,
    }));
  const unusedBranches = [...state.branches.keys()].filter((id) => !state.usedBranches.has(id));
  const nextActions: string[] = [];
  if (state.budgetStop) {
    nextActions.push(
      `Build a continuation from failedSteps and pendingSteps with a fresh explicit budget; ${state.budgetStop} was exhausted.`,
    );
  }
  if (unresolved.length > 0) {
    nextActions.push(
      "Correct observation inputs or add an explicit recovery branch, then re-run unresolved assertions.",
    );
  }
  if (state.failures.some((failure) => failure.kind === "blocked" && !failure.recovered)) {
    nextActions.push("Obtain mutation authorization before setting allowMutations=true.");
  }
  if (state.failures.some((failure) => failure.kind === "loop" && !failure.recovered)) {
    nextActions.push(
      "Change the action input or choose a different tool; identical mutation retries stay blocked.",
    );
  }
  if (nextActions.length === 0 && pendingSteps.length === 0) {
    nextActions.push("No continuation is required; preserve the evidence timeline as proof.");
  }
  return { failedSteps, pendingSteps, unusedFallbacks: unusedBranches, nextActions };
}

export async function runAdaptiveWorkflow(
  input: AdaptiveWorkflowInput,
  ctx: ToolContext,
): Promise<ToolResult> {
  const catalogList = ctx.tools.list();
  const catalog = new Map(catalogList.map((tool) => [tool.name, tool]));
  if (!input.steps || input.steps.length === 0) {
    const plan = schemaAwarePlan(input.goal, catalogList, input.allowMutations);
    return {
      data: {
        status: "plan-only",
        requestedMode: input.mode,
        goal: input.goal,
        ...plan,
        budgets: input.budgets,
      },
      summary: `Generated a deterministic schema-aware plan for "${input.goal}"; nothing executed.`,
    };
  }
  const validation = validateExplicitWorkflow(input, catalog);
  const preview = previewSteps(input, catalog);
  if (input.mode !== "execute") {
    return {
      data: {
        status: input.mode,
        goal: input.goal,
        allowMutations: input.allowMutations,
        budgets: input.budgets,
        validation,
        canExecute: !validation.some((issue) => issue.severity === "error"),
        plan: preview,
        continuationPlan: [
          "Fix every validation error.",
          "Review mutation warnings and semantic assertions.",
          "Switch mode to execute without changing validated inputs.",
        ],
      },
      summary: `${input.mode === "preview" ? "Previewed" : "Planned"} ${input.steps.length} explicit step(s); nothing executed.`,
    };
  }
  const structuralErrors = validation.filter((issue) => issue.severity === "error");
  if (structuralErrors.length > 0) {
    return {
      data: {
        status: "blocked",
        goal: input.goal,
        validation,
        plan: preview,
        evidenceTimeline: [],
        budgetsConsumed: {
          steps: { used: 0, limit: input.budgets.maxSteps, remaining: input.budgets.maxSteps },
          toolCalls: {
            used: 0,
            limit: input.budgets.maxToolCalls,
            remaining: input.budgets.maxToolCalls,
          },
          timeMs: { used: 0, limit: input.budgets.timeoutMs, remaining: input.budgets.timeoutMs },
          exhausted: null,
        },
        completionConfidence: {
          score: 0,
          level: "low",
          basis: "Structural validation failed before execution.",
        },
        unresolvedAssertions: [],
        recoveryRecommendations: structuralErrors.map((issue) => issue.message),
        continuationPlan: {
          failedSteps: [],
          pendingSteps: input.steps.map((step) => ({ id: step.id, tool: step.tool })),
          unusedFallbacks: input.fallbacks.map((branch) => branch.id),
          nextActions: ["Correct structural validation errors, then preview again."],
        },
      },
      summary: `Execution blocked by ${structuralErrors.length} structural validation error(s).`,
      isError: true,
    };
  }
  const startedAt = Date.now();
  const state: RuntimeState = {
    input,
    ctx,
    catalog,
    branches: new Map(input.fallbacks.map((branch) => [branch.id, branch])),
    startedAt,
    deadlineAt: startedAt + input.budgets.timeoutMs,
    outputs: new Map(),
    evidence: [],
    failures: [],
    assertions: new Map(),
    resolvedAssertions: new Map(),
    signatures: new Map(),
    usedBranches: new Set(),
    executedStepIds: new Set(),
    recoveryRecommendations: [],
    stepsUsed: 0,
    successfulSteps: 0,
    toolCallsUsed: 0,
    budgetStop: null,
    intentionallyStopped: false,
  };
  const mainResult = await executeSequence(state, input.steps);
  if (mainResult.reachedEnd && !state.budgetStop && !state.intentionallyStopped) {
    const goalFailure = await runAssertions(state, "goal", input.successAssertions, "goal");
    if (goalFailure) {
      const syntheticStep: AdaptiveStep = {
        type: "tool",
        id: "goal-assertions",
        tool: "assert-state",
        input: {},
        assertions: [],
        recoverWith: input.finalRecoverWith,
        onFailure: "stop",
      };
      const record: FailureRecord = {
        stepId: syntheticStep.id,
        tool: syntheticStep.tool,
        kind: goalFailure.kind,
        message: goalFailure.message,
        assertionIds: goalFailure.assertionIds,
        recovered: false,
      };
      state.failures.push(record);
      record.explanation = await explainFailure(state, syntheticStep, goalFailure, {});
      const fallback = selectBranch(state, syntheticStep, goalFailure.kind);
      if (fallback && !state.budgetStop) {
        state.usedBranches.add(fallback.id);
        record.recoveryBranch = fallback.id;
        pushEvidence(state, {
          kind: "fallback",
          status: "selected",
          stepId: syntheticStep.id,
          branchId: fallback.id,
        });
        const branchResult = await executeSequence(state, fallback.steps, fallback.id);
        const recheckIds = goalFailure.assertionIds.filter((id) =>
          fallback.resolvesAssertions.includes(id),
        );
        const recheck = recheckIds.flatMap((id) => {
          const assertion = state.resolvedAssertions.get(id);
          return assertion ? [assertion] : [];
        });
        if (
          branchResult.reachedEnd &&
          !branchResult.hadUnrecoveredFailure &&
          recheck.length === goalFailure.assertionIds.length
        ) {
          record.recovered =
            (await runAssertions(state, "goal", recheck, "recovery-recheck")) === null;
        }
      }
    }
  }
  const unresolvedAssertions = [...state.assertions.values()].filter(
    (assertion) => assertion.passed !== true,
  );
  const unrecoveredFailures = state.failures.filter((failure) => !failure.recovered);
  const pendingMain = input.steps.filter((step) => !state.executedStepIds.has(step.id));
  const status = state.budgetStop
    ? "budget-exhausted"
    : state.intentionallyStopped
      ? "partial"
      : unrecoveredFailures.length === 0 &&
          unresolvedAssertions.length === 0 &&
          pendingMain.length === 0
        ? "completed"
        : state.successfulSteps > 0
          ? "partial"
          : unrecoveredFailures.some((failure) => failure.kind === "blocked")
            ? "blocked"
            : "failed";
  const continuationPlan = buildContinuation(state, input.steps, unresolvedAssertions);
  return {
    data: {
      status,
      goal: input.goal,
      evidenceTimeline: state.evidence,
      references: Object.fromEntries(state.outputs),
      failures: state.failures,
      budgetsConsumed: consumedBudgets(state),
      completionConfidence: confidenceFor(state, status),
      unresolvedAssertions,
      recoveryRecommendations: state.recoveryRecommendations,
      continuationPlan,
    },
    summary: `${state.successfulSteps}/${state.stepsUsed} step(s) succeeded; status ${status}.`,
    isError: status !== "completed",
  };
}
