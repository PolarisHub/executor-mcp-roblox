import { z } from "zod";

import {
  assessToolDefinition,
  buildToolGuidance,
} from "../../application/services/tool-definition-quality.js";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "tool-quality-audit",
  title: "Audit definition quality across the complete tool catalog",
  description:
    "Read-only catalog self-audit for tool titles, descriptions, input documentation, schema examples/defaults/constraints, AI data-flow contracts, prerequisites, capability requirements, mutation side effects, verification paths, and recovery guidance. It evaluates the same centrally compiled metadata exposed to MCP clients, so every current and future tool can be checked against one measurable standard. Filter by exact name/category or return only entries below a score threshold; no Roblox client is required.",
  category: "Utility",
  requiresClient: false,
  input: z.object({
    name: z.string().optional().describe("Optional exact kebab-case tool name to audit."),
    category: z.string().optional().describe("Optional exact category name to audit."),
    minimumScore: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .default(85)
      .describe("Score below which a definition is reported as needing attention."),
    includePassing: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include definitions meeting or exceeding minimumScore."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe(
        "Maximum detailed tool reports returned; aggregate counts always cover the full filter.",
      ),
  }),
  async execute({ name, category, minimumScore, includePassing, limit }, ctx) {
    const selected = ctx.tools
      .list()
      .filter((tool) => (name ? tool.name === name : true))
      .filter((tool) => (category ? tool.category === category : true));
    const reports = selected.map((tool) => {
      const quality = tool.quality ?? assessToolDefinition(tool);
      const guidance = buildToolGuidance(tool);
      return {
        name: tool.name,
        title: tool.title,
        category: tool.category,
        score: quality.score,
        grade: quality.grade,
        issues: quality.issues,
        strengths: quality.strengths,
        explicitFieldDescriptions: quality.explicitFieldDescriptions,
        inferredFieldDescriptions: quality.inferredFieldDescriptions,
        signature: guidance.signature,
        requiredInputs: guidance.requiredInputs,
        phase: guidance.execution.phase,
        estimatedCost: guidance.execution.estimatedCost,
        mutatesState: guidance.safety.mutatesState,
        sideEffects: guidance.safety.sideEffects,
        verifiesWith: guidance.success.verifiesWith,
        recoverySteps: guidance.recovery.length,
      };
    });

    const byGrade: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    const byCategory = new Map<
      string,
      { count: number; scoreTotal: number; belowThreshold: number }
    >();
    let scoreTotal = 0;
    let explicitFieldDescriptions = 0;
    let inferredFieldDescriptions = 0;
    for (const report of reports) {
      byGrade[report.grade] = (byGrade[report.grade] ?? 0) + 1;
      scoreTotal += report.score;
      explicitFieldDescriptions += report.explicitFieldDescriptions;
      inferredFieldDescriptions += report.inferredFieldDescriptions;
      const current = byCategory.get(report.category) ?? {
        count: 0,
        scoreTotal: 0,
        belowThreshold: 0,
      };
      current.count += 1;
      current.scoreTotal += report.score;
      if (report.score < minimumScore) current.belowThreshold += 1;
      byCategory.set(report.category, current);
    }

    const detailed = reports
      .filter((report) => includePassing || report.score < minimumScore)
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
      .slice(0, limit);

    return {
      data: {
        filter: { name: name ?? null, category: category ?? null },
        threshold: minimumScore,
        aggregate: {
          tools: reports.length,
          averageScore:
            reports.length > 0 ? Math.round((scoreTotal / reports.length) * 10) / 10 : 0,
          passing: reports.filter((report) => report.score >= minimumScore).length,
          belowThreshold: reports.filter((report) => report.score < minimumScore).length,
          byGrade,
          explicitFieldDescriptions,
          inferredFieldDescriptions,
          effectiveUndocumentedFields: 0,
        },
        categories: [...byCategory.entries()]
          .map(([categoryName, value]) => ({
            category: categoryName,
            count: value.count,
            averageScore: Math.round((value.scoreTotal / value.count) * 10) / 10,
            belowThreshold: value.belowThreshold,
          }))
          .sort((a, b) => a.category.localeCompare(b.category)),
        count: detailed.length,
        truncated:
          detailed.length < reports.filter((r) => includePassing || r.score < minimumScore).length,
        tools: detailed,
        note: "Inferred descriptions are exposed to clients immediately and remain visible as authoring debt until replaced with explicit field docs.",
      },
      summary: `Audited ${reports.length} tool definition(s); ${reports.filter((r) => r.score < minimumScore).length} below ${minimumScore}.`,
    };
  },
});
