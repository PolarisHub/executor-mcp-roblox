import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Read the executor's current render FPS cap via getfpscap(). 0 typically means
 * uncapped.
 */
export default defineTool({
  name: "get-fps-cap",
  title: "Read the current FPS cap (sUNC getfpscap)",
  description:
    "Read the executor's current render frame-rate cap via getfpscap(). Returns the cap as a number; 0 means " +
    "uncapped. Requires a Volt-class executor exposing getfpscap. The call is type-guarded and pcall-wrapped: if " +
    "getfpscap is missing you get { error = 'getfpscap is not available in this executor.' }. Returns { fpsCap } " +
    "or { error }.",
  category: "Utility",
  input: z.object({
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ threadContext, timeoutMs }, ctx) {
    const source = `
if type(getfpscap) ~= "function" then
  return { error = "getfpscap is not available in this executor." }
end
local ok, cap = pcall(getfpscap)
if not ok then return { error = tostring(cap) } end
return { fpsCap = cap }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
