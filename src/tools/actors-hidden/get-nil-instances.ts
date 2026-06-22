import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { HIDDEN_PRELUDE } from "../_shared/hidden.js";

export default defineTool({
  name: "get-nil-instances",
  title: "List nil-parented (hidden) instances",
  description:
    "Enumerate instances whose Parent is nil (getnilinstances). Nil-parenting is a classic hiding spot: a remote, " +
    "script, GUI, or other object is kept alive by a reference but is unreachable from the game tree, so it never " +
    "shows up in the Explorer or normal descendant scans. This returns the total count, a byClass breakdown " +
    "(ClassName -> count) computed across ALL nil instances, and a capped samples list (each with class, name, and " +
    "full path) for inspection. Requires getnilinstances (Volt-class executors); degrades with a clear error " +
    "otherwise.",
  category: "Actors & Hidden",
  input: z.object({
    limit: z
      .number()
      .int()
      .describe(
        "Max number of sample instances to return in the samples list (default 500, max 3000). The byClass counts " +
          "and total always cover every nil instance regardless of this limit.",
      )
      .optional()
      .default(500),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, threadContext }, ctx) {
    const cap = Math.min(Math.max(Math.floor(limit), 1), 3000);
    const source = `
${HIDDEN_PRELUDE}
if type(getnilinstances) ~= "function" then
  return { error = "getnilinstances is not available in this executor." }
end

local okN, nils = pcall(getnilinstances)
if not okN or type(nils) ~= "table" then
  return { error = "getnilinstances() failed or returned no table." }
end

local byClass = {}
local samples = {}
local total = 0
for _, inst in nils do
  total = total + 1
  local cls = __class(inst)
  byClass[cls] = (byClass[cls] or 0) + 1
  if #samples < ${cap} then
    samples[#samples + 1] = {
      class = cls,
      name = __name(inst),
      fullName = __fullName(inst),
    }
  end
end

return { total = total, byClass = byClass, truncated = total > #samples, samples = samples }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
