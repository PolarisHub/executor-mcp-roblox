import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Clear any teleport-queued code via clearqueueonteleport().
 */
export default defineTool({
  name: "clear-queue-on-teleport",
  title: "Clear teleport-queued code (sUNC clearqueueonteleport)",
  description:
    "WRITES EXECUTOR STATE — clears any code previously queued with queueonteleport, via " +
    "clearqueueonteleport(). After this, nothing will auto-run on the next teleport. Requires " +
    "clearqueueonteleport. The call is type-guarded and pcall-wrapped: if clearqueueonteleport " +
    "is missing you get { error = 'clearqueueonteleport is not available in this executor.' }. Returns " +
    "{ cleared } or { error }.",
  category: "Utility",
  mutatesState: true,
  input: z.object({
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ threadContext, timeoutMs }, ctx) {
    const source = `
if type(clearqueueonteleport) ~= "function" then
  return { error = "clearqueueonteleport is not available in this executor." }
end
local ok, err = pcall(clearqueueonteleport)
if not ok then return { error = tostring(err) } end
return { cleared = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
