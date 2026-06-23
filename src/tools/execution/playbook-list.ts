import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "playbook-list",
  title: "List Saved Luau Playbooks",
  description:
    "List every persisted playbook in ~/.executor-mcp/playbooks/, optionally filtered to one tag. Returns " +
    "summary metadata only (name, description, tags, params, timestamps) — fetch the source via `playbook-run` " +
    "or by reading the file. Newest-first by updatedAt.",
  category: "Execution",
  mutatesState: false,
  requiresClient: false,
  input: z.object({
    tag: z.string().optional().describe("Restrict to playbooks carrying this tag."),
    includeSource: z
      .boolean()
      .optional()
      .describe("When true, include the full Luau source per entry (default false: metadata only)."),
  }),
  async execute({ tag, includeSource }, ctx) {
    const items = await ctx.playbooks.list(tag ? { tag } : undefined);
    return {
      data: {
        total: items.length,
        playbooks: items.map((p) => ({
          name: p.name,
          description: p.description ?? null,
          tags: p.tags ?? [],
          params: p.params ?? [],
          createdAt: p.createdAt ?? null,
          updatedAt: p.updatedAt ?? null,
          ...(includeSource ? { source: p.source } : {}),
        })),
      },
    };
  },
});
