import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "vm-reset",
  title: "Reset the Persistent Script VM",
  description:
    "Wipe the persistent VM environment used by the `script` tool. Every global, function, and value defined by " +
    "previous persistent `script` runs is discarded, giving you a clean session. This does NOT touch the game " +
    "itself — only the VM's own sandboxed environment. Returns { reset = true }.",
  category: "Execution",
  mutatesState: false,
  input: z.object({}),
  async execute(_input, ctx) {
    const data = await ctx.runLuau("", { env: "vm-reset", timeoutMs: 10000 });
    return { data, summary: "Persistent VM environment reset." };
  },
});
