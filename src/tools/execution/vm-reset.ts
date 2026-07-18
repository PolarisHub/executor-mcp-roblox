import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "vm-reset",
  title: "Reset the Persistent Script VM",
  description:
    "Wipe the persistent VM environment used by the `script` tool. Every global, function, and value defined by " +
    "previous persistent `script` runs is discarded, giving you a clean session. This does NOT touch the game " +
    "itself — only the VM's own sandboxed environment. Wipes ONLY your own scope: pass the same `agent` label " +
    "(and `client`) you run scripts under so it clears that agent's VM on that game, never a co-tenant's. " +
    "Returns { reset = true }.",
  category: "Execution",
  mutatesState: false,
  input: z.object({
    client: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Reset the VM on a specific connected client (its clientId or username) for THIS call, " +
          "instead of your session's selected client.",
      ),
    agent: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Reset the persistent VM belonging to this agent lane — pass the SAME label you run your " +
          "`script`/`execute` calls under, so you clear your own VM and not a co-tenant agent's.",
      ),
  }),
  async execute(_input, ctx) {
    const data = await ctx.runLuau("", { env: "vm-reset", timeoutMs: 10000 });
    return { data, summary: "Persistent VM environment reset." };
  },
});
