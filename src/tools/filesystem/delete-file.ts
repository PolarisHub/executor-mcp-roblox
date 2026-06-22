import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "delete-file",
  title: "Delete a file from the executor workspace (UNC delfile)",
  description:
    "Delete a single file from the executor's workspace folder. NOTE: this is executor-side file I/O — the connector " +
    "runs INSIDE the executor, so the path is relative to the executor's workspace directory on the host machine, NOT " +
    "the Roblox game. This is destructive and cannot be undone. " +
    "Requires a Volt-class executor exposing the UNC function delfile(path). The call is type-guarded and " +
    "pcall-wrapped: if delfile is missing you get { error = 'delfile is not available in this executor.' }, and any " +
    "failure (missing file, permission) returns { error = <message> }. " +
    "Returns { path, ok = true } or { error }.",
  category: "Filesystem",
  mutatesState: true,
  input: z.object({
    path: z
      .string()
      .describe("Path to the file to delete within the executor workspace, e.g. 'logs/old.txt'."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ path, threadContext, timeoutMs }, ctx) {
    const source = `
if type(delfile) ~= "function" then
  return { error = "delfile is not available in this executor." }
end
local ok, err = pcall(delfile, ${q(path)})
if not ok then return { error = tostring(err) } end
return { path = ${q(path)}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
