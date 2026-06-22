import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Set the executor's render FPS cap via setfpscap(n). 0 typically means uncapped.
 */
export default defineTool({
  name: "set-fps-cap",
  title: "Set the render FPS cap (sUNC setfpscap)",
  description:
    "WRITES CLIENT STATE — sets the executor's render frame-rate cap via setfpscap(cap). Pass 0 to uncap the " +
    "frame rate. Requires a Volt-class executor exposing setfpscap. The call is type-guarded and pcall-wrapped: if " +
    "setfpscap is missing you get { error = 'setfpscap is not available in this executor.' }. Returns { cap, ok } " +
    "or { error }.",
  category: "Utility",
  mutatesState: true,
  input: z.object({
    cap: z.number().describe("The target frame-rate cap; 0 means uncapped (no limit)."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ cap, threadContext, timeoutMs }, ctx) {
    const source = `
if type(setfpscap) ~= "function" then
  return { error = "setfpscap is not available in this executor." }
end
local ok, err = pcall(setfpscap, ${cap})
if not ok then return { error = tostring(err) } end
return { cap = ${cap}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
