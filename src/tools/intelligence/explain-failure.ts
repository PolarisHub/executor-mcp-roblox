import { z } from "zod";
import { classifyFailure } from "../../application/services/recovery-intelligence.js";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "explain-failure",
  title: "Explain and recover from a failed tool call",
  description:
    "READ-ONLY AND NO CLIENT REQUIRED. Deterministically classify a failed MCP/Roblox tool call from its error, " +
    "handled result, attempted input, and optional context. Returns a standard recovery envelope with cause, exact " +
    "evidence, confidence, retry safety, a schema-validated correctedInput only when safely derivable, live-registry " +
    "fallback tools ranked using AI contracts and discovery, an optional useful recovery script, and concrete next " +
    "actions. Use this after any failed or blocked call. It never invokes a fallback and never recommends repeating " +
    "an identical failed mutation.",
  category: "Intelligence",
  requiresClient: false,
  mutatesState: false,
  ai: {
    phase: "observe",
    prerequisites: [],
    consumes: ["failed tool name", "error or handled result", "attempted input"],
    produces: ["failure classification", "safe retry policy", "ranked recovery plan"],
    verifiesWith: [],
    alternatives: ["agent-context", "tool-plan", "tool-schema"],
    requiresCapabilities: [],
    sideEffects: [],
    failureRecovery: [
      "provide the complete error code/message and handled result when classification is unknown",
    ],
  },
  input: z.object({
    toolName: z
      .string()
      .min(1)
      .describe("Exact name of the tool that failed or returned a handled error."),
    error: z
      .unknown()
      .optional()
      .describe("Thrown error, transport error, domain error object, or error message."),
    result: z
      .unknown()
      .optional()
      .describe("Handled tool result or partial result associated with the failure."),
    attemptedInput: z
      .unknown()
      .optional()
      .describe(
        "The exact input passed to the failed tool; used for mutation safety and corrections.",
      ),
    context: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Optional structured facts such as selection state, resolvedPath, correctedInput, capability results, or recent observations.",
      ),
  }),
  async execute(input, ctx) {
    const explanation = classifyFailure(input, ctx.tools);
    return {
      data: explanation,
      summary: `Classified ${input.toolName} as ${explanation.cause} (${Math.round(explanation.confidence * 100)}% confidence).`,
    };
  },
});
