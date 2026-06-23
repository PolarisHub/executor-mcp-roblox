import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "session-list",
  title: "List Recorded Tool-Call Sessions",
  description:
    "Enumerate every recorded session in ~/.executor-mcp/sessions/<id>.jsonl. Each entry shows sessionId, " +
    "sessionLabel (e.g. 'live'), startedAt, endedAt, the number of recorded calls, and file size. Newest-first. " +
    "Use the returned sessionId with `session-show` to read records or `session-replay` to plan a re-issue.",
  category: "Diagnostics",
  mutatesState: false,
  requiresClient: false,
  input: z.object({}),
  async execute(_input, ctx) {
    const sessions = await ctx.sessionLogger.list();
    return { data: { total: sessions.length, sessions } };
  },
});
