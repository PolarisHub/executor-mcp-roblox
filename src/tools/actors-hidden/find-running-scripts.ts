import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { HIDDEN_PRELUDE } from "../_shared/hidden.js";

export default defineTool({
  name: "find-running-scripts",
  title: "List currently-running scripts",
  description:
    "List every script that is currently executing (getrunningscripts), including ones that are not visible in the " +
    "normal hierarchy — nil-parented, detached from the DataModel, running inside an Actor, or living in CoreGui. " +
    "For each running script this returns its name, class, full path, where it actually lives (location), and whether " +
    "it is still reachable from the game tree (inTree). This surfaces active anti-detection / obfuscated logic that " +
    "is running but hidden from the Explorer. Requires getrunningscripts (Volt-class executors); degrades with a " +
    "clear error otherwise. Output is capped at 300 scripts with a truncated flag.",
  category: "Actors & Hidden",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
${HIDDEN_PRELUDE}
if type(getrunningscripts) ~= "function" then
  return { error = "getrunningscripts is not available in this executor." }
end

local okR, running = pcall(getrunningscripts)
if not okR or type(running) ~= "table" then
  return { error = "getrunningscripts() failed or returned no table." }
end

local out = {}
local total = 0
for _, s in running do
  total = total + 1
  if #out < 300 then
    out[#out + 1] = {
      name = __name(s),
      class = __class(s),
      fullName = __fullName(s),
      location = __location(s),
      inTree = __inTree(s),
    }
  end
end

return { runningCount = total, truncated = total > #out, scripts = out }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
