import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "run-luau",
  title: "Run Luau on the active client",
  description:
    "Execute arbitrary Luau in the active Roblox client and return its first returned value (decoded from JSON). " +
    "This is the core PURE-LUAU execution tool — no access to this server's other tools from inside the script. " +
    "If you want to use any other tool's data (get-players, search-instances, discover-player-values, anything from " +
    "list-tools) inside your Luau, STOP and use the `script` tool instead: it binds a live `mcp` table so you can " +
    "write `local p = mcp.getPlayers()` / `mcp.searchInstances({...})` / `mcp.parallel({...})` and use the results " +
    "directly — one call instead of dozens of round-trips. Use `run-luau` only when your Luau is fully self-contained " +
    "(reading workspace, looping over a part, returning a value). `return` the value(s) you want back; do NOT call " +
    "JSONEncode yourself, the connector serializes automatically. A chunk that returns nothing yields null. " +
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
