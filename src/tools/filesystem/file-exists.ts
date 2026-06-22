import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "file-exists",
  title: "Check whether a path is a file or folder in the executor workspace (UNC isfile/isfolder)",
  description:
    "Probe a path in the executor's workspace and report whether it is an existing file and/or an existing folder. " +
    "NOTE: this is executor-side file I/O — the connector runs INSIDE the executor, so the path is relative to the " +
    "executor's workspace directory on the host machine, NOT the Roblox game. " +
    "Requires a Volt-class executor exposing the UNC functions isfile(path) -> bool and isfolder(path) -> bool. Each " +
    "is type-guarded and pcall-wrapped INDEPENDENTLY: if a probe's function is missing or errors, its result is " +
    "reported as false. If NEITHER isfile nor isfolder is available you get " +
    "{ error = 'isfile/isfolder are not available in this executor.' }. " +
    "Returns { path, isFile, isFolder } or { error }.",
  category: "Filesystem",
  input: z.object({
    path: z
      .string()
      .describe(
        "Path within the executor workspace to probe, e.g. 'config.json' or 'data'. Reported as file and/or folder.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ path, threadContext, timeoutMs }, ctx) {
    const source = `
local hasFile = type(isfile) == "function"
local hasFolder = type(isfolder) == "function"
if not hasFile and not hasFolder then
  return { error = "isfile/isfolder are not available in this executor." }
end
local isFile = false
local isFolder = false
if hasFile then
  local ok, res = pcall(isfile, ${q(path)})
  if ok then isFile = res == true end
end
if hasFolder then
  local ok, res = pcall(isfolder, ${q(path)})
  if ok then isFolder = res == true end
end
return { path = ${q(path)}, isFile = isFile, isFolder = isFolder }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
