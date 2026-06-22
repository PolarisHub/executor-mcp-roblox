import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "make-folder",
  title: "Create a folder in the executor workspace (UNC makefolder)",
  description:
    "Create a folder (and any required parent folders) inside the executor's workspace. NOTE: this is executor-side " +
    "file I/O — the connector runs INSIDE the executor, so the path is relative to the executor's workspace directory " +
    "on the host machine, NOT the Roblox game. " +
    "Requires the UNC function makefolder(path). The call is type-guarded and " +
    "pcall-wrapped: if makefolder is missing you get { error = 'makefolder is not available in this executor.' }, and " +
    "any failure returns { error = <message> }. Creating a folder that already exists is a no-op on most executors. " +
    "Returns { path, ok = true } or { error }.",
  category: "Filesystem",
  mutatesState: true,
  input: z.object({
    path: z
      .string()
      .describe(
        "Path to the folder to create within the executor workspace, e.g. 'data' or 'data/snapshots'.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ path, threadContext, timeoutMs }, ctx) {
    const source = `
if type(makefolder) ~= "function" then
  return { error = "makefolder is not available in this executor." }
end
local ok, err = pcall(makefolder, ${q(path)})
if not ok then return { error = tostring(err) } end
return { path = ${q(path)}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
