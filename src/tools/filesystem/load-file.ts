import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "load-file",
  title: "Compile a workspace Luau file without running it (UNC loadfile)",
  description:
    "Compile a Luau file from the executor's workspace into a function WITHOUT executing it, to verify that it parses " +
    "and to surface any syntax error. NOTE: this is executor-side file I/O — the connector runs INSIDE the executor, " +
    "so the path is relative to the executor's workspace directory on the host machine, NOT the Roblox game. This " +
    "tool intentionally does NOT call the compiled function; it only reports whether compilation succeeded. " +
    "Requires a Volt-class executor exposing the UNC function loadfile(path) -> (fn?, err?). The call is type-guarded " +
    "and pcall-wrapped: if loadfile is missing you get { error = 'loadfile is not available in this executor.' }. On " +
    "a compile error loadfile returns nil plus an error string, surfaced as { compiled = false, error }. " +
    "Returns { path, compiled, error? } or { error }.",
  category: "Filesystem",
  input: z.object({
    path: z
      .string()
      .describe(
        "Path to the Luau file within the executor workspace to compile-check, e.g. 'scripts/main.lua'.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ path, threadContext, timeoutMs }, ctx) {
    const source = `
if type(loadfile) ~= "function" then
  return { error = "loadfile is not available in this executor." }
end
local ok, fn, err = pcall(loadfile, ${q(path)})
if not ok then return { error = tostring(fn) } end
if type(fn) == "function" then
  return { path = ${q(path)}, compiled = true }
end
return { path = ${q(path)}, compiled = false, error = tostring(err) }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
