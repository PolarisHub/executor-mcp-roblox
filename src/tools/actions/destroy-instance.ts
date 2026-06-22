import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "destroy-instance",
  title: "Destroy a live Instance (IRREVERSIBLE)",
  description:
    "WRITES LIVE GAME STATE. Resolve a Luau expression to an Instance and permanently remove it from the game via " +
    "inst:Destroy(). Destroy() unparents the instance and ALL of its descendants, disconnects their events, and locks " +
    "their Parent so they can never be re-parented — the subtree is gone. The instance's full path and ClassName are " +
    "captured BEFORE destruction so the response records exactly what was removed. WARNING: THIS IS IRREVERSIBLE — " +
    "there is no undo; you cannot get the instance back (use clone-instance first if you might need a copy). " +
    "Destroying a player's Character, a critical service child, or a script can break the running game and may " +
    "replicate to the server. Only destroy instances you are certain about. Returns { Destroyed, ClassName, ok } or " +
    "{ error }.",
  category: "Actions",
  mutatesState: true,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau expression resolving to the Instance to destroy, e.g. 'game.Workspace.UnwantedPart', " +
          "'game.Players.LocalPlayer.PlayerGui.Ad', or 'game.Workspace:FindFirstChild(\"Trap\")'. Evaluated as " +
          "`return <instancePath>`. Resolve the EXACT instance — Destroy also removes every descendant.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
local inst, err = __eval(${q(instancePath)})
if err then return { error = err } end
if typeof(inst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(inst) .. "): " .. ${q(instancePath)} } end

local destroyed = ${q(instancePath)}
local okName, full = pcall(function() return inst:GetFullName() end)
if okName then destroyed = full end

local className = "<unknown>"
local okCls, cls = pcall(function() return inst.ClassName end)
if okCls then className = cls end

if type(inst.Destroy) ~= "function" then return { error = "this Instance has no Destroy method." } end

local okDestroy, destroyErr = pcall(function() inst:Destroy() end)
if not okDestroy then return { error = "Destroy() raised an error: " .. tostring(destroyErr) } end

return {
  Destroyed = destroyed,
  ClassName = className,
  ok = true,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
