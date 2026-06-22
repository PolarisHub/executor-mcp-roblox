import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "list-files",
  title: "List entries in an executor workspace folder (UNC listfiles)",
  description:
    "List the files and subfolders directly inside a folder in the executor's workspace, returning their paths. " +
    "NOTE: this is executor-side file I/O — the connector runs INSIDE the executor, so the path is relative to the " +
    "executor's workspace directory on the host machine, NOT the Roblox game. Pass an empty string to list the " +
    "workspace root. " +
    "Requires the UNC function listfiles(path) -> { string }. The call is " +
    "type-guarded and pcall-wrapped: if listfiles is missing you get " +
    "{ error = 'listfiles is not available in this executor.' }, and any failure (missing folder) returns " +
    "{ error = <message> }. The returned list is capped at 1000 entries with a 'truncated' flag. " +
    "Returns { path, files, count, truncated } or { error }.",
  category: "Filesystem",
  input: z.object({
    path: z
      .string()
      .describe(
        "Path to the folder within the executor workspace, e.g. '' (root), 'logs', or 'data/snapshots'.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ path, threadContext, timeoutMs }, ctx) {
    const source = `
if type(listfiles) ~= "function" then
  return { error = "listfiles is not available in this executor." }
end
local ok, entries = pcall(listfiles, ${q(path)})
if not ok then return { error = tostring(entries) } end
if type(entries) ~= "table" then return { error = "listfiles did not return a table." } end
local files = {}
local truncated = false
for _, entry in ipairs(entries) do
  if #files >= 1000 then truncated = true break end
  files[#files + 1] = tostring(entry)
end
return { path = ${q(path)}, files = files, count = #files, truncated = truncated }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
