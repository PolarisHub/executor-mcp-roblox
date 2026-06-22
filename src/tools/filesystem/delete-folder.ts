import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "delete-folder",
  title: "Delete a folder from the executor workspace (UNC delfolder)",
  description:
    "Delete a folder (and typically its contents) from the executor's workspace. NOTE: this is executor-side file " +
    "I/O — the connector runs INSIDE the executor, so the path is relative to the executor's workspace directory on " +
    "the host machine, NOT the Roblox game. This is destructive and recursive on most executors; it cannot be undone. " +
    "Requires the UNC function delfolder(path). The call is type-guarded and " +
    "pcall-wrapped: if delfolder is missing you get { error = 'delfolder is not available in this executor.' }, and " +
    "any failure (missing folder, permission) returns { error = <message> }. " +
    "Returns { path, ok = true } or { error }.",
  category: "Filesystem",
  mutatesState: true,
  input: z.object({
    path: z
      .string()
      .describe(
        "Path to the folder to delete within the executor workspace, e.g. 'data/snapshots'.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ path, threadContext, timeoutMs }, ctx) {
    const source = `
if type(delfolder) ~= "function" then
  return { error = "delfolder is not available in this executor." }
end
local ok, err = pcall(delfolder, ${q(path)})
if not ok then return { error = tostring(err) } end
return { path = ${q(path)}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
