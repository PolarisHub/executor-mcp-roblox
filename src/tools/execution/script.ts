import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Runs a Luau program in the active client with a built-in `mcp` table that can
 * call any other tool inline — but the bridge is the existing WebSocket, not an
 * executor HTTP request. The connector pre-binds `mcp` and captures print/warn
 * from inside the run, returning `{ result, output }` (or `{ error, output }`).
 *
 * Compared to the previous design this:
 *   - eliminates the executor `request()` call from the hot path,
 *   - eliminates HttpService:JSONEncode/Decode in the script wrapper,
 *   - eliminates the giant Luau preamble that used to be prepended at compile time.
 * The token still gates server-side access through {@link ScriptBridge}.
 */
export default defineTool({
  name: "script",
  title: "Run a Luau Script with the Whole Tool Surface (mcp.*) + Persistent VM",
  description:
    "Run a Luau program in the active Roblox client that can ALSO call any other tool inline through a live `mcp` " +
    "table, and use the results in the same script — one call instead of dozens of round-trips. Inside the script: " +
    "`game`, `workspace`, and all in-game globals are available, PLUS `mcp.<tool>(args)` invokes any of this " +
    "server's tools and RETURNS its data. Tool names are camelCase of the tool id (e.g. `mcp.getPlayers()`, " +
    "`mcp.searchInstances({ className = 'RemoteEvent' })`, `mcp.findFunctionsByName({ name = 'buy' })`), or use " +
    "`mcp.call('kebab-tool-name', { ... })`. `print`/`warn` are captured and returned as `output` (and still " +
    "stream to the dashboard Output console). By default the script runs in a PERSISTENT VM: globals and " +
    "functions you define survive across `script` calls (a REPL-like session) — set persistent:false for a " +
    "clean one-shot, or call `vm-reset` to wipe the VM. Returns `{ result = <return value>, output = [lines] }` " +
    "or `{ error, output }`. mcp.script is disabled (no recursion).",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    source: z
      .string()
      .describe(
        "The Luau script to run. Has `game`/`workspace`/all in-game globals, plus `mcp.<tool>(args)` to call any " +
          "tool and use its returned data inline. `print`/`warn` are captured. `return <value>` to hand a value back.",
      ),
    persistent: z
      .boolean()
      .optional()
      .describe(
        "Run in the persistent VM so defined globals/functions survive across calls (default true). " +
          "false = a fresh, isolated environment each run.",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Overall timeout for the whole script including nested tool calls (default 120000)."),
    threadContext: z.number().int().optional(),
  }),
  async execute({ source, persistent, timeoutMs, threadContext }, ctx) {
    if (!ctx.scripting) {
      return {
        data: { error: "The scripting bridge is not available on this server." },
        isError: true,
      };
    }
    const { token, dispose } = ctx.scripting.mint();
    try {
      const data = await ctx.runLuau(source, {
        timeoutMs: timeoutMs ?? 120000,
        env: persistent === false ? "fresh" : "vm",
        scriptToken: token,
        ...(threadContext !== undefined ? { threadContext } : {}),
      });
      return { data };
    } finally {
      dispose();
    }
  },
});
