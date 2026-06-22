import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Read the host hardware identifier via the executor's gethwid().
 */
export default defineTool({
  name: "get-hwid",
  title: "Read the host hardware ID (sUNC gethwid)",
  description:
    "Read the host machine's hardware identifier (HWID) via the executor's gethwid(). This is the stable " +
    "per-machine fingerprint executors commonly use for key-system/license binding. Requires gethwid. " +
    "The call is type-guarded and pcall-wrapped: if gethwid is missing you get " +
    "{ error = 'gethwid is not available in this executor.' }. Returns { hwid } or { error }.",
  category: "Utility",
  input: z.object({
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ threadContext, timeoutMs }, ctx) {
    const source = `
if type(gethwid) ~= "function" then
  return { error = "gethwid is not available in this executor." }
end
local ok, hwid = pcall(gethwid)
if not ok then return { error = tostring(hwid) } end
return { hwid = hwid }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
