import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "run-luau",
  title: "Run Luau on the active client",
  description:
    "Execute arbitrary Luau in the active Roblox client and return its first returned value (decoded from JSON). " +
    "This is the core code-execution tool — `return` the value(s) you want back; do NOT call JSONEncode yourself, " +
    "the connector serializes the result automatically. A chunk that returns nothing yields null. " +
    "Use eval-expression for a single expression, or the higher-level inspection tools for structured reads.",
  category: "Execution",
  input: z.object({
    source: z
      .string()
      .min(1)
      .describe("Luau source to execute. Use `return <value>` to get data back."),
    threadContext: z
      .number()
      .int()
      .optional()
      .describe(
        "Roblox thread identity to run under (e.g. 2 = game scripts, 8 = elevated). Server default if omitted.",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Per-call deadline in milliseconds. Server default if omitted."),
  }),
  mutatesState: true,
  async execute({ source, threadContext, timeoutMs }, ctx) {
    const result = await ctx.runLuau(source, {
      ...(threadContext !== undefined ? { threadContext } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return { data: result };
  },
});
