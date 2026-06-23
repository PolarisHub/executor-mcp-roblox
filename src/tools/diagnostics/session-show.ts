import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "session-show",
  title: "Read Recorded Tool Calls from a Session",
  description:
    "Read a window of recorded tool calls from one session's JSONL trace. Pass `sessionId` (from " +
    "`session-list`) and optional `from`/`to` to bound the seq range (1-indexed, inclusive). Each record has " +
    "{ seq, at, tool, input, result?|error?, elapsedMs, clientId?, sessionId } — exactly what the invoker " +
    "saw. Useful for auditing what was run and feeding `session-replay`.",
  category: "Diagnostics",
  mutatesState: false,
  requiresClient: false,
  input: z.object({
    sessionId: z.string().min(1).describe("Session UUID from session-list."),
    from: z.number().int().positive().optional().describe("Start at this seq (default 1)."),
    to: z.number().int().positive().optional().describe("Stop at this seq (default end-of-file)."),
    limit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("Cap returned records (default 200)."),
  }),
  async execute({ sessionId, from, to, limit }, ctx) {
    const opts: { from?: number; to?: number } = {};
    if (from !== undefined) opts.from = from;
    if (to !== undefined) opts.to = to;
    const records = await ctx.sessionLogger.read(sessionId, opts);
    const capped = records.slice(0, limit ?? 200);
    return {
      data: {
        sessionId,
        returned: capped.length,
        total: records.length,
        records: capped,
      },
    };
  },
});
