import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "read-file",
  title: "Read a file from the executor workspace (UNC readfile)",
  description:
    "Read the entire contents of a file from the executor's workspace folder and return it as a string. " +
    "NOTE: this is executor-side file I/O — the connector runs INSIDE the executor, so paths are relative to the " +
    "executor's workspace directory on the host machine, NOT anything in the Roblox game/DataModel. " +
    "Requires a Volt-class executor exposing the UNC function readfile(path). The call is type-guarded and " +
    "pcall-wrapped: if readfile is missing you get { error = 'readfile is not available in this executor.' }, and " +
    "any read failure (missing file, permission) returns { error = <message> }. " +
    "Returns { path, content } or { error }.",
  category: "Filesystem",
  input: z.object({
    path: z
      .string()
      .describe(
        "Path to the file within the executor workspace folder, e.g. 'config.json' or 'logs/session.txt'. " +
          "Resolved by the executor relative to its own workspace directory.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ path, threadContext, timeoutMs }, ctx) {
    const source = `
if type(readfile) ~= "function" then
  return { error = "readfile is not available in this executor." }
end
local ok, content = pcall(readfile, ${q(path)})
if not ok then return { error = tostring(content) } end
return { path = ${q(path)}, content = content }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
