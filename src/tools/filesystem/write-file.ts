import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "write-file",
  title: "Write (overwrite) a file in the executor workspace (UNC writefile)",
  description:
    "Write content to a file in the executor's workspace folder, creating it if needed and OVERWRITING any existing " +
    "contents. NOTE: this is executor-side file I/O — the connector runs INSIDE the executor, so the path is relative " +
    "to the executor's workspace directory on the host machine, NOT the Roblox game. " +
    "Requires the UNC function writefile(path, content). The call is type-guarded and " +
    "pcall-wrapped: if writefile is missing you get { error = 'writefile is not available in this executor.' }, and " +
    "any write failure (bad path, denied extension, permission) returns { error = <message> }. " +
    "Returns { path, ok = true } or { error }.",
  category: "Filesystem",
  mutatesState: true,
  input: z.object({
    path: z
      .string()
      .describe(
        "Path to the file within the executor workspace folder, e.g. 'config.json'. Existing contents are replaced.",
      ),
    content: z.string().describe("The full text content to write to the file."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ path, content, threadContext, timeoutMs }, ctx) {
    const source = `
if type(writefile) ~= "function" then
  return { error = "writefile is not available in this executor." }
end
local ok, err = pcall(writefile, ${q(path)}, ${q(content)})
if not ok then return { error = tostring(err) } end
return { path = ${q(path)}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
