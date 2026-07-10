import { z } from "zod";
import {
  describeInputFields,
  inputSignature,
} from "../../application/services/schema-introspect.js";
import { matchWorkflows, rankTools } from "../../application/services/tool-discovery.js";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "tool-plan",
  title: "Turn a natural-language goal into a tool workflow",
  description:
    "READ-ONLY. Convert a vague Roblox goal into a ranked, schema-aware workflow. Give this tool the user's " +
    "natural-language objective, not a guessed tool name. It combines intent aliases, the live tool catalog, " +
    "available schemas, mutation flags, and curated discover→act→verify recipes. Use the returned workflow as a " +
    "starting point, then inspect the exact schema of the selected tool before calling it. This is especially useful " +
    "for goals involving UI/input, remotes, player values, instance inspection, or reverse engineering.",
  category: "Utility",
  requiresClient: false,
  input: z.object({
    goal: z
      .string()
      .min(3)
      .describe(
        "Natural-language objective, e.g. 'find the player's cash and verify its current value'.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .default(8)
      .describe("Maximum ranked alternatives to return."),
    includeMutating: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include tools that write game state in the ranked alternatives and workflow."),
  }),
  async execute({ goal, limit, includeMutating }, ctx) {
    const all = ctx.tools.list();
    const usable = includeMutating ? all : all.filter((tool) => !tool.mutatesState);
    const ranked = rankTools(goal, usable, limit);
    const available = new Set(usable.map((tool) => tool.name));
    const workflows = matchWorkflows(goal, available);
    const workflow = workflows[0] ?? null;
    const describe = (tool: (typeof usable)[number]) => ({
      name: tool.name,
      title: tool.title,
      category: tool.category,
      signature: inputSignature(tool.input),
      args: describeInputFields(tool.input),
      mutatesState: tool.mutatesState,
      requiresClient: tool.requiresClient,
    });
    const formatWorkflow = (candidate: (typeof workflows)[number]) => ({
      id: candidate.id,
      title: candidate.title,
      description: candidate.description,
      steps: candidate.steps.flatMap((step, index) => {
        const target = all.find((tool) => tool.name === step.tool);
        return target ? [{ step: index + 1, ...step, ...describe(target) }] : [];
      }),
    });

    return {
      data: {
        goal,
        interpretation:
          workflow?.title ??
          "No curated recipe matched; use the ranked candidates as an exploratory shortlist.",
        workflow: workflow ? formatWorkflow(workflow) : null,
        workflows: workflows.map(formatWorkflow),
        alternatives: ranked.map((entry) => ({
          ...describe(entry.tool),
          score: Math.round(entry.score * 10) / 10,
          matchedTerms: entry.matchedTerms,
          why: entry.why,
        })),
        guidance: [
          "Prefer discover/read-only steps before mutation.",
          "Call tool-schema with the selected name if any required argument is unclear.",
          "Use script when several steps depend on earlier results; use mcp.parallel for independent reads.",
          ...(includeMutating
            ? []
            : [
                "Mutating tools were excluded; set includeMutating=true when you are ready to act.",
              ]),
        ],
      },
      summary: `${ranked.length} candidate tools${workflow ? `; recommended recipe: ${workflow.title}` : ""}.`,
    };
  },
});
