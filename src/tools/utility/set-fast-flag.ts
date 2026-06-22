import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Write a Roblox FastFlag value via the executor's setfflag(name, value).
 * Overrides an engine feature toggle for the running client; the value is passed
 * as a string (the executor coerces it to the flag's native type).
 */
export default defineTool({
  name: "set-fast-flag",
  title: "Override a Roblox FastFlag value (sUNC setfflag)",
  description:
    "WRITES CLIENT STATE — overrides a Roblox engine FastFlag for the running client via setfflag(name, value). " +
    "The value is supplied as a string and coerced by the executor to the flag's native type (bool/int/string). " +
    "This changes engine behavior at runtime and can destabilize the client if a flag is set to an invalid value. " +
    "Requires a Volt-class executor exposing setfflag. The call is type-guarded and pcall-wrapped: if setfflag is " +
    "missing you get { error = 'setfflag is not available in this executor.' }. Returns { name, value, ok } or " +
    "{ error }.",
  category: "Utility",
  mutatesState: true,
  input: z.object({
    name: z.string().describe("The FastFlag name to override, e.g. 'DFIntTaskSchedulerTargetFps'."),
    value: z.string().describe("The new value as a string (e.g. '120', 'true', or a text value)."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ name, value, threadContext, timeoutMs }, ctx) {
    const source = `
if type(setfflag) ~= "function" then
  return { error = "setfflag is not available in this executor." }
end
local ok, err = pcall(setfflag, ${q(name)}, ${q(value)})
if not ok then return { error = tostring(err) } end
return { name = ${q(name)}, value = ${q(value)}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
