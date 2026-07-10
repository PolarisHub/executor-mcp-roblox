import { z } from "zod";
import {
  describeInputFields,
  inputSignature,
} from "../../application/services/schema-introspect.js";
import { matchWorkflows, rankTools } from "../../application/services/tool-discovery.js";
import { defineTool } from "../../application/tool/define-tool.js";
import type { ToolContract, ToolContext, ToolResult } from "../../application/tool/tool.js";

const stepSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe("Stable step identifier used by later $steps.<id> references."),
  tool: z.string().min(1).describe("Registered kebab-case tool name."),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe("Tool arguments; values may use $steps references."),
  verifyWith: z
    .string()
    .optional()
    .describe("Optional read-only verifier tool; defaults to the tool contract's verifier."),
  verifyInput: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Verifier arguments; defaults to the resolved action input."),
  retries: z
    .number()
    .int()
    .nonnegative()
    .max(3)
    .optional()
    .default(0)
    .describe(
      "Retries for read-only failures; mutations are not retried unless retryMutations=true.",
    ),
});

function getPath(root: unknown, path: string): unknown {
  let value = root;
  for (const part of path.split(".").filter(Boolean)) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    if (Array.isArray(value) && /^\d+$/.test(part)) value = value[Number(part)];
    else value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function resolveValue(value: unknown, results: ReadonlyMap<string, unknown>): unknown {
  if (typeof value === "string") {
    const match = /^\$(?:steps|result)\.([A-Za-z0-9_-]+)(?:\.(.*))?$/.exec(value);
    if (!match) return value;
    const root = results.get(match[1]!);
    if (root === undefined) throw new Error(`Unknown step reference "${value}".`);
    return match[2] ? getPath(root, match[2]) : root;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, results));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveValue(entry, results)]),
    );
  }
  return value;
}

function contractFor(tool: {
  ai?: ToolContract;
  name: string;
  mutatesState?: boolean;
}): ToolContract {
  return (
    tool.ai ?? {
      phase: tool.mutatesState ? "act" : "observe",
      prerequisites: [],
      consumes: [],
      produces: [],
      verifiesWith: [],
      alternatives: [],
      requiresCapabilities: [],
      sideEffects: tool.mutatesState ? ["writes live game/client state"] : [],
      failureRecovery: [],
    }
  );
}

function describeTool(tool: ReturnType<ToolContext["tools"]["list"]>[number]) {
  const ai = contractFor(tool);
  return {
    name: tool.name,
    title: tool.title,
    category: tool.category,
    signature: inputSignature(tool.input),
    args: describeInputFields(tool.input),
    mutatesState: tool.mutatesState,
    requiresClient: tool.requiresClient,
    ai,
  };
}

export default defineTool({
  name: "agent-run",
  title: "Execute a verified multi-tool AI workflow",
  description:
    "ORCHESTRATES LIVE TOOLS. Execute an explicit discover→act→verify workflow with step IDs, result references, " +
    "dry-run planning, mutation approval, retries, and automatic contract-based verification. Use `agent-context` " +
    "and `tool-plan` first when the goal is vague, then pass concrete `steps`. Each later input can reference earlier " +
    "data with `$steps.stepId.data.field` or `$result.stepId.data.field`. By default mutations are blocked and only " +
    "read-only steps run; set allowMutations=true only when the user authorized state changes. Mutating steps are never " +
    "retried unless retryMutations=true. If `steps` is omitted, this returns a schema-aware plan instead of guessing " +
    "required arguments. This is the main closed-loop execution surface for AI agents.",
  category: "Utility",
  requiresClient: false,
  mutatesState: true,
  ai: {
    phase: "orchestrate",
    prerequisites: [],
    consumes: ["natural-language goal", "explicit tool steps"],
    produces: ["step results", "verification results", "next actions"],
    verifiesWith: [],
    alternatives: ["script", "tool-plan"],
    requiresCapabilities: [],
    sideEffects: ["may execute multiple tools; mutations require allowMutations=true"],
    failureRecovery: ["inspect failed step and retry with corrected references or schema"],
  },
  input: z.object({
    goal: z
      .string()
      .min(3)
      .describe("Human-readable goal used for planning, summaries, and audit output."),
    steps: z
      .array(stepSchema)
      .max(50)
      .optional()
      .describe("Explicit ordered steps. Omit to receive a plan only."),
    dryRun: z
      .boolean()
      .optional()
      .default(false)
      .describe("Validate and return the workflow without executing anything."),
    allowMutations: z
      .boolean()
      .optional()
      .default(false)
      .describe("Permit tools marked mutatesState=true to execute."),
    retryMutations: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Permit retries for mutating steps; disabled by default to avoid duplicate side effects.",
      ),
    verify: z
      .boolean()
      .optional()
      .default(true)
      .describe("Run each step's contract verifier when available."),
    stopOnError: z
      .boolean()
      .optional()
      .default(true)
      .describe("Stop after the first failed or blocked step."),
    maxSteps: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .default(20)
      .describe("Hard execution cap for this run."),
  }),
  async execute(
    { goal, steps, dryRun, allowMutations, retryMutations, verify, stopOnError, maxSteps },
    ctx,
  ) {
    const catalog = ctx.tools.list();
    const descriptors = new Map(catalog.map((tool) => [tool.name, tool]));
    if (!steps || steps.length === 0) {
      const workflows = matchWorkflows(goal, new Set(catalog.map((tool) => tool.name)));
      const alternatives = rankTools(goal, catalog, 10).map((entry) => ({
        ...describeTool(entry.tool),
        score: entry.score,
        why: entry.why,
      }));
      return {
        data: {
          status: "plan-only",
          goal,
          workflows,
          alternatives,
          next: "Provide explicit steps to agent-run after choosing arguments from tool-schema.",
        },
        summary: `Plan generated; no steps executed for "${goal}".`,
      };
    }

    const boundedSteps = steps.slice(0, Math.min(maxSteps, 50));
    const plan = boundedSteps.map((step) => {
      const tool = descriptors.get(step.tool);
      return {
        id: step.id,
        tool: step.tool,
        input: step.input,
        known: tool !== undefined,
        blocked: tool?.mutatesState === true && !allowMutations,
        ...(tool ? describeTool(tool) : {}),
      };
    });
    if (dryRun) {
      return {
        data: {
          status: "dry-run",
          goal,
          allowMutations,
          plan,
          next: "Set dryRun=false to execute this validated plan.",
        },
        summary: `Dry-run validated ${plan.length} workflow step(s).`,
      };
    }

    const outputs = new Map<string, unknown>();
    const results: Record<string, unknown>[] = [];
    let failed = false;
    for (const step of boundedSteps) {
      const tool = descriptors.get(step.tool);
      if (!tool) {
        results.push({
          id: step.id,
          tool: step.tool,
          status: "failed",
          error: `Unknown tool "${step.tool}".`,
        });
        failed = true;
        if (stopOnError) break;
        continue;
      }
      if (tool.mutatesState && !allowMutations) {
        results.push({
          id: step.id,
          tool: step.tool,
          status: "blocked",
          reason: "Mutation not approved; set allowMutations=true.",
        });
        failed = true;
        if (stopOnError) break;
        continue;
      }
      let resolvedInput: unknown;
      try {
        resolvedInput = resolveValue(step.input, outputs);
      } catch (error) {
        results.push({
          id: step.id,
          tool: step.tool,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        failed = true;
        if (stopOnError) break;
        continue;
      }

      const attempts = Math.min(
        step.retries + 1,
        tool.mutatesState && !retryMutations ? 1 : step.retries + 1,
      );
      let result: ToolResult | undefined;
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          result = await ctx.invokeTool(tool.name, resolvedInput);
          if (!result.isError || attempt === attempts) break;
        } catch (error) {
          lastError = error;
          if (attempt === attempts) break;
        }
      }
      if (!result && lastError) {
        results.push({
          id: step.id,
          tool: step.tool,
          status: "failed",
          error: lastError instanceof Error ? lastError.message : JSON.stringify(lastError),
        });
        failed = true;
        if (stopOnError) break;
        continue;
      }
      const output = result?.data;
      outputs.set(step.id, { data: output, result: output, summary: result?.summary });
      const entry: Record<string, unknown> = {
        id: step.id,
        tool: step.tool,
        status: result?.isError ? "failed" : "ok",
        data: output,
        ...(result?.summary ? { summary: result.summary } : {}),
      };
      if (result?.isError) {
        failed = true;
        entry["error"] = "Tool returned a handled error.";
      } else if (verify) {
        const contract = contractFor(tool);
        const verifierName = step.verifyWith ?? contract.verifiesWith[0];
        if (verifierName) {
          const verifier = descriptors.get(verifierName);
          if (!verifier) {
            entry["verification"] = {
              status: "unavailable",
              error: `Verifier "${verifierName}" is not registered.`,
            };
          } else if (verifier.mutatesState) {
            entry["verification"] = { status: "unavailable", error: "Verifier must be read-only." };
          } else {
            try {
              const verificationInput = resolveValue(step.verifyInput ?? resolvedInput, outputs);
              const verification = await ctx.invokeTool(verifierName, verificationInput);
              entry["verification"] = {
                status: verification.isError ? "failed" : "ok",
                data: verification.data,
              };
              if (verification.isError) failed = true;
            } catch (error) {
              entry["verification"] = {
                status: "failed",
                error: error instanceof Error ? error.message : JSON.stringify(error),
              };
              failed = true;
            }
          }
        }
      }
      results.push(entry);
      if (failed && stopOnError) break;
    }

    return {
      data: {
        status: failed ? "failed" : "completed",
        goal,
        results,
        references: Object.fromEntries(outputs),
        next: failed
          ? "Inspect the failed step, correct its input or capability assumption, then retry."
          : "Goal workflow completed; use the verification fields as proof.",
      },
      summary: `${results.length}/${boundedSteps.length} workflow step(s) executed${failed ? " with failures" : " successfully"}.`,
      isError: failed,
    };
  },
});
