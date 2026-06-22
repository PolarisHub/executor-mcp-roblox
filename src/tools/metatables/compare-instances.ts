import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "compare-instances",
  title: "Test whether two references point at the same underlying instance",
  description:
    "Resolve two Luau expressions and report whether they reference the SAME underlying Roblox instance via " +
    "compareinstances. This matters because a game (or an executor proxy/clone) can hand you a wrapped userdata " +
    "whose identity differs from the real Instance even though `==` or :GetFullName() looks identical — and some " +
    "anticheat hands out decoy/newproxy objects. compareinstances unwraps those and compares true instance " +
    "identity, so you can confirm 'is this captured remote actually game.ReplicatedStorage.RemoteEvent, or a " +
    "lookalike?'. Non-mutating. Requires compareinstances; returns { Same, TypeA, TypeB } or { error } when the " +
    "capability is missing or either expression fails to evaluate.",
  category: "Metatables & Closures",
  input: z.object({
    pathA: z
      .string()
      .describe(
        "First Luau expression to compare, e.g. 'game.ReplicatedStorage.RemoteEvent' or a captured handle like " +
          "'getgenv().__capturedRemote'. Evaluated as `return <pathA>`.",
      ),
    pathB: z
      .string()
      .describe(
        "Second Luau expression to compare against pathA, e.g. 'getreg()[123]' or 'getrawmetatable(game).__index'. " +
          "Evaluated as `return <pathB>`.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ pathA, pathB, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(compareinstances) ~= "function" then return { error = "compareinstances is not available in this executor." } end
local a, errA = __eval(${q(pathA)})
if errA then return { error = "pathA: " .. errA } end
local b, errB = __eval(${q(pathB)})
if errB then return { error = "pathB: " .. errB } end

local okC, same = pcall(compareinstances, a, b)
if not okC then return { error = "compareinstances failed: " .. tostring(same) } end

return {
  PathA = ${q(pathA)},
  PathB = ${q(pathB)},
  TypeA = typeof(a),
  TypeB = typeof(b),
  Same = same,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
