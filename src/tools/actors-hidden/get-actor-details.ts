import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { HIDDEN_PRELUDE, q } from "../_shared/hidden.js";
import { REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-actor-details",
  title: "Inspect Actor(s) and their scripts",
  description:
    "Drill into Actor instances (parallel-Luau VMs) and report their contents. Actors run code in isolated VMs " +
    "outside the normal serial scheduler, so they are a common place to hide logic. Give an actorPath to inspect ONE " +
    "Actor in detail, or omit it to summarize EVERY Actor (getactors). For each Actor this returns its name, where it " +
    "lives (in tree / nil-parented / detached / inside CoreGui), how many descendants it has, and a list (capped at 30 " +
    "per Actor) of the LuaSourceContainer scripts inside it — each with name, class, full path, and whether the script " +
    "is currently executing (running, determined by membership in getrunningscripts). This complements list-actors by " +
    "adding the running flag, the descendant count, and single-target resolution from a Luau expression. Requires " +
    "getactors (Volt-class executors); getrunningscripts is used additionally when present (running falls back to false " +
    "if it is unavailable). Returns a single Actor object when actorPath is given, otherwise { actorCount, truncated, " +
    "actors: [...] }. Degrades with a clear error if getactors is missing or actorPath does not resolve to an Actor.",
  category: "Actors & Hidden",
  input: z.object({
    actorPath: z
      .string()
      .describe(
        "Optional Luau expression resolving to a single Actor to inspect, e.g. " +
          "'workspace.MyModel.Actor' or 'getactors()[1]'. Evaluated as `return <actorPath>` and validated to be an " +
          "Instance that IsA('Actor'). If omitted, ALL actors from getactors() are summarized.",
      )
      .optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ actorPath, threadContext }, ctx) {
    const hasActorPath = typeof actorPath === "string" && actorPath.trim().length > 0;
    const source = `
${REFLECT_PRELUDE}
${HIDDEN_PRELUDE}
if type(getactors) ~= "function" then
  return { error = "getactors is not available in this executor." }
end

-- Build a fast lookup set of currently-running scripts (if available).
local runningSet = {}
if type(getrunningscripts) == "function" then
  local okR, rs = pcall(getrunningscripts)
  if okR and type(rs) == "table" then
    for _, s in rs do runningSet[s] = true end
  end
end

local SCRIPT_CAP = 30

local function describeActor(actor)
  local entry = {
    name = __name(actor),
    location = __location(actor),
    descendantCount = 0,
    scripts = {},
  }
  local okD, descendants = pcall(function() return actor:GetDescendants() end)
  if okD and type(descendants) == "table" then
    local scriptCount = 0
    for _, d in descendants do
      entry.descendantCount = entry.descendantCount + 1
      if __isA(d, "LuaSourceContainer") then
        scriptCount = scriptCount + 1
        if #entry.scripts < SCRIPT_CAP then
          entry.scripts[#entry.scripts + 1] = {
            name = __name(d),
            class = __class(d),
            path = __fullName(d),
            running = runningSet[d] == true,
          }
        end
      end
    end
    entry.scriptCount = scriptCount
    entry.scriptsTruncated = scriptCount > #entry.scripts
  end
  return entry
end

local single = ${hasActorPath ? "true" : "false"}
if single then
  local actor, err = __eval(${q(actorPath ?? "")})
  if err then return { error = err } end
  if typeof(actor) ~= "Instance" then
    return { error = "actorPath did not resolve to an Instance (got " .. typeof(actor) .. ")." }
  end
  if not __isA(actor, "Actor") then
    return { error = "actorPath resolved to a " .. __class(actor) .. ", not an Actor." }
  end
  return describeActor(actor)
end

local okA, actors = pcall(getactors)
if not okA or type(actors) ~= "table" then
  return { error = "getactors() failed or returned no table." }
end

local out = {}
local total = 0
for _, actor in actors do
  total = total + 1
  if #out < 200 then
    out[#out + 1] = describeActor(actor)
  end
end

return { actorCount = total, truncated = total > #out, actors = out }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
