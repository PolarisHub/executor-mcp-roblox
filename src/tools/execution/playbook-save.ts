import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export default defineTool({
  name: "playbook-save",
  title: "Save a Named Reusable Luau Playbook",
  description:
    "Persist a named, optionally parameterized Luau snippet to ~/.executor-mcp/playbooks/<name>.json so it can " +
    "be re-run later via `playbook-run`. Names must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/. The source is " +
    "stored verbatim; ${param} placeholders are replaced at run-time by `playbook-run`. Use tags to group " +
    "related playbooks (e.g. 'recon', 'farming'). Upserts on existing names.",
  category: "Execution",
  mutatesState: false,
  requiresClient: false,
  input: z.object({
    name: z
      .string()
      .regex(NAME_RE, "name must be 1–64 chars of letters/digits/_/-, starting with alphanumeric")
      .describe("Filename-safe identifier (used as the JSON file basename)."),
    source: z
      .string()
      .min(1)
      .describe("The Luau source to save. Use ${param} placeholders for runtime substitution."),
    description: z.string().optional().describe("One-line summary of what this playbook does."),
    tags: z.array(z.string()).optional().describe("Free-form tags for grouping (e.g. ['recon','farming'])."),
    params: z
      .array(z.string())
      .optional()
      .describe("Names of ${param} placeholders the source uses (for documentation + UI hints)."),
  }),
  async execute(input, ctx) {
    const stored = await ctx.playbooks.save(input);
    return {
      data: { ok: true, name: stored.name, updatedAt: stored.updatedAt, createdAt: stored.createdAt },
      summary: `Saved playbook "${stored.name}".`,
    };
  },
});
