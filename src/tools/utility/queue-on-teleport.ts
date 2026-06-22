import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Queue Luau source to run automatically after the next teleport via
 * queueonteleport(code). The queued code persists across the teleport boundary
 * and executes in the destination place.
 */
export default defineTool({
  name: "queue-on-teleport",
  title: "Queue code to run after the next teleport (sUNC queueonteleport)",
  description:
    "WRITES EXECUTOR STATE — queues a chunk of Luau source via queueonteleport(code) so it runs automatically " +
    "after the NEXT teleport completes, in the destination place. This is how scripts survive a Roblox teleport: " +
    "the queued code persists across the place change and executes once the new place loads. Requires a Volt-class " +
    "executor exposing queueonteleport. The call is type-guarded and pcall-wrapped: if queueonteleport is missing " +
    "you get { error = 'queueonteleport is not available in this executor.' }. Returns { queued } or { error }.",
  category: "Utility",
  mutatesState: true,
  input: z.object({
    code: z.string().describe("The Luau source to run automatically after the next teleport."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ code, threadContext, timeoutMs }, ctx) {
    const source = `
if type(queueonteleport) ~= "function" then
  return { error = "queueonteleport is not available in this executor." }
end
local ok, err = pcall(queueonteleport, ${q(code)})
if not ok then return { error = tostring(err) } end
return { queued = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
