import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Read a Roblox FastFlag value via the executor's getfflag(name). FastFlags are
 * the engine's runtime feature toggles; the executor exposes the current value
 * as a string (or nil when the flag is unknown).
 */
export default defineTool({
  name: "get-fast-flag",
  title: "Read a Roblox FastFlag value (sUNC getfflag)",
  description:
    "Read the current value of a Roblox engine FastFlag by name via the executor's getfflag(name). FastFlags " +
    "(FFlag/DFFlag/FInt/etc.) are the runtime feature toggles the Roblox client reads at startup; getfflag returns " +
    "the current value as a string, or nil when the flag is unknown. Requires a Volt-class executor exposing " +
    "getfflag. The call is type-guarded and pcall-wrapped: if getfflag is missing you get " +
    "{ error = 'getfflag is not available in this executor.' }. Returns { name, value } or { error }.",
  category: "Utility",
  input: z.object({
    name: z
      .string()
      .describe("The FastFlag name, e.g. 'DFIntTaskSchedulerTargetFps' or 'FFlagDebugDisplayFPS'."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ name, threadContext, timeoutMs }, ctx) {
    const source = `
if type(getfflag) ~= "function" then
  return { error = "getfflag is not available in this executor." }
end
local ok, value = pcall(getfflag, ${q(name)})
if not ok then return { error = tostring(value) } end
return { name = ${q(name)}, value = value }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
