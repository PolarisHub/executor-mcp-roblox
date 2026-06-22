import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { HIDDEN_PRELUDE } from "../_shared/hidden.js";

export default defineTool({
  name: "list-actors",
  title: "List Actor scripts (parallel-Luau VMs)",
  description:
    "Enumerate every Actor instance in the game (getactors). Actors run code in isolated parallel-Luau VMs, so " +
    "scripts inside them execute outside the normal serial scheduler and are a common place to hide logic. For each " +
    "Actor this returns its name, full path, where it lives (in tree / nil-parented / detached / CoreGui), how many " +
    "LuaSourceContainer descendants it has, and — when includeScripts is true — a capped list (30 per Actor) of those " +
    "scripts with their name, class, and full path. Requires getactors (Volt-class executors); degrades with a clear " +
    "error otherwise. Output is capped at 200 actors with a truncated flag.",
  category: "Actors & Hidden",
  input: z.object({
    includeScripts: z
      .boolean()
      .describe(
        "If true (default), list each Actor's descendant LuaSourceContainers (scripts), capped at 30 per actor. " +
          "Set false for a lighter scan that only reports counts.",
      )
      .optional()
      .default(true),
    threadContext: z.number().int().optional(),
  }),
  async execute({ includeScripts, threadContext }, ctx) {
    const source = `
${HIDDEN_PRELUDE}
if type(getactors) ~= "function" then
  return { error = "getactors is not available in this executor." }
end

local includeScripts = ${includeScripts ? "true" : "false"}
local okA, actors = pcall(getactors)
if not okA or type(actors) ~= "table" then
  return { error = "getactors() failed or returned no table." }
end

local out = {}
local total = 0
for _, actor in actors do
  total = total + 1
  if #out < 200 then
    local entry = {
      name = __name(actor),
      fullName = __fullName(actor),
      location = __location(actor),
      scriptCount = 0,
    }
    local scripts = {}
    local okD, descendants = pcall(function() return actor:GetDescendants() end)
    if okD and type(descendants) == "table" then
      for _, d in descendants do
        if __isA(d, "LuaSourceContainer") then
          entry.scriptCount = entry.scriptCount + 1
          if includeScripts and #scripts < 30 then
            scripts[#scripts + 1] = {
              name = __name(d),
              class = __class(d),
              fullName = __fullName(d),
            }
          end
        end
      end
    end
    if includeScripts then entry.scripts = scripts end
    out[#out + 1] = entry
  end
end

return { actorCount = total, truncated = total > #out, actors = out }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
