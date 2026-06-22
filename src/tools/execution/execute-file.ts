import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "execute-file",
  title: "Execute a Luau file on the active client",
  description:
    "Read a Luau script from the SERVER host filesystem and execute its contents on the active Roblox client, " +
    "returning the first value the script returns (decoded automatically — `return` what you want back). " +
    "The path is read through an allow-list sandbox: only files inside the configured roots (the server's working " +
    "directory, ~/Documents, and any extra script directories set in the config) can be read, and symlinks that " +
    "escape those roots are rejected. A path outside the allow-list, or a missing file, returns an error without " +
    "running anything. Use run-luau when you already have the source inline.",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    path: z
      .string()
      .min(1)
      .describe("Absolute or relative path to a .lua/.luau file inside an allow-listed root."),
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
      .optional()
      .describe("Per-call deadline in milliseconds. Server default if omitted."),
  }),
  async execute({ path, threadContext, timeoutMs }, ctx) {
    let contents: string;
    try {
      contents = await ctx.host.fs.readText(path);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return { data: { file: path, error }, isError: true };
    }

    const data = await ctx.runLuau(contents, {
      ...(threadContext !== undefined ? { threadContext } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return { data: { file: path, result: data } };
  },
});
