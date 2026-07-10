import { defineTool } from "../../application/tool/define-tool.js";
import {
  adaptiveWorkflowInputSchema,
  runAdaptiveWorkflow,
} from "../../application/services/adaptive-workflow.js";

export default defineTool({
  name: "smart-task",
  title: "Plan or execute an adaptive verified task",
  description:
    "DETERMINISTIC ADAPTIVE ORCHESTRATOR. Turn a goal into a schema-aware plan, preview an explicit typed workflow, " +
    "or execute it one tool at a time under hard step, tool-call, and wall-clock budgets. Inputs may safely reference " +
    "prior outputs with exact $steps.<id>.<path> references. Mutations require allowMutations=true and an identical " +
    "mutating action is never retried. Semantic postconditions are delegated to the read-only assert-state tool and " +
    "count as verified only when it returns explicit boolean truth. Handled failures may be diagnosed by the read-only " +
    "explain-failure tool and can activate only named recoverWith branches supplied by the caller. The result includes " +
    "an evidence timeline, consumed budgets, confidence, unresolved assertions, recovery advice, and a continuation plan. " +
    "This tool contains no LLM: omitted steps produce deterministic rankTools/matchWorkflows suggestions and leave " +
    "required arguments blank instead of guessing them.",
  category: "Intelligence",
  requiresClient: false,
  mutatesState: true,
  ai: {
    phase: "orchestrate",
    prerequisites: [],
    consumes: [
      "goal",
      "explicit typed steps",
      "semantic success assertions",
      "mutation approval",
      "hard execution budgets",
    ],
    produces: [
      "schema-aware plan",
      "evidence timeline",
      "assertion truth",
      "completion confidence",
      "continuation plan",
    ],
    verifiesWith: ["assert-state"],
    alternatives: ["agent-run", "tool-plan", "script"],
    requiresCapabilities: [],
    sideEffects: [
      "may invoke multiple registered tools",
      "mutating nested tools require allowMutations=true",
    ],
    failureRecovery: [
      "inspect unresolvedAssertions and evidenceTimeline",
      "use only explicitly declared recoverWith branches",
      "resume pending steps with a fresh hard budget",
    ],
  },
  input: adaptiveWorkflowInputSchema,
  execute(input, ctx) {
    return runAdaptiveWorkflow(input, ctx);
  },
});
