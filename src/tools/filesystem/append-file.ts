import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "append-file",
  title: "Append content to a file in the executor workspace (UNC appendfile)",
  description:
    "Append content to the end of a file in the executor's workspace folder, creating the file first if it does not " +
    "exist. Existing contents are preserved (unlike write-file, which overwrites). NOTE: this is executor-side file " +
    "I/O — the connector runs INSIDE the executor, so the path is relative to the executor's workspace directory on " +
    "the host machine, NOT the Roblox game. " +
    "Requires a Volt-class executor exposing the UNC function appendfile(path, content). The call is type-guarded and " +
    "pcall-wrapped: if appendfile is missing you get { error = 'appendfile is not available in this executor.' }, and " +
    "any failure returns { error = <message> }. " +
    "Returns { path, ok = true } or { error }.",
  category: "Filesystem",
  mutatesState: true,
  input: z.object({
    path: z
      .string()
      .describe(
        "Path to the file within the executor workspace folder, e.g. 'logs/session.txt'. Created if missing.",
      ),
    content: z.string().describe("The text content to append to the end of the file."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ path, content, threadContext, timeoutMs }, ctx) {
    const source = `
if type(appendfile) ~= "function" then
  return { error = "appendfile is not available in this executor." }
end
local ok, err = pcall(appendfile, ${q(path)}, ${q(content)})
if not ok then return { error = tostring(err) } end
return { path = ${q(path)}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
