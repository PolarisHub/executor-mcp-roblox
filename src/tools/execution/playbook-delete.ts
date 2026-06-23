import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "playbook-delete",
  title: "Delete a Saved Luau Playbook",
  description:
    "Remove a persisted playbook from ~/.executor-mcp/playbooks/. Returns { ok: true, removed: true } when " +
    "the file was deleted, or { ok: true, removed: false } when it didn't exist. Does not touch any running " +
    "scripts that loaded this playbook earlier.",
  category: "Execution",
  mutatesState: true,
  requiresClient: false,
  input: z.object({
    name: z.string().min(1).describe("Playbook name to delete."),
  }),
  async execute({ name }, ctx) {
    const removed = await ctx.playbooks.delete(name);
    return {
      data: { ok: true, removed },
      summary: removed ? `Deleted playbook "${name}".` : `No playbook named "${name}".`,
    };
  },
});
