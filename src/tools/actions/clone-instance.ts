import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "clone-instance",
  title: "Clone a live Instance",
  description:
    "WRITES LIVE GAME STATE. Resolve a Luau expression to a source Instance, deep-copy it via source:Clone() (which " +
    "duplicates the instance and all of its descendants), and optionally parent the clone into the game tree. Useful " +
    "while debugging for duplicating a template Part/Model/GUI, spawning extra copies of an item, or capturing a " +
    "snapshot of a subtree before mutating the original. The clone starts parentless; it is parented LAST and only if " +
    "parentPath is provided. NOTE: :Clone() only succeeds when the source's Archivable property is true — a clone of a " +
    "non-Archivable instance returns nil and yields a clean error. WARNING: a parented clone immediately affects the " +
    "running game and may replicate. Returns { Source, Clone, Parented, ok } or { error }.",
  category: "Actions",
  mutatesState: true,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau expression resolving to the source Instance to clone, e.g. 'game.ReplicatedStorage.Templates.Coin', " +
          "'game.Workspace.Model', or 'game.Players.LocalPlayer.PlayerGui.Main'. Evaluated as `return <instancePath>`.",
      ),
    parentPath: z
      .string()
      .describe(
        "Optional Luau expression resolving to the Instance that should become the clone's Parent, e.g. " +
          "'game.Workspace' or 'game.Players.LocalPlayer.PlayerGui'. Evaluated as `return <parentPath>`. Set after " +
          "the clone is made. Omit to leave the clone parentless (it still exists in memory).",
      )
      .optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, parentPath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
local src, err = __eval(${q(instancePath)})
if err then return { error = err } end
if typeof(src) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(src) .. "): " .. ${q(instancePath)} } end

local srcPath = ${q(instancePath)}
local okSrcName, srcFull = pcall(function() return src:GetFullName() end)
if okSrcName then srcPath = srcFull end

local okClone, cloneOrErr = pcall(function() return src:Clone() end)
if not okClone then return { error = "Clone() raised an error: " .. tostring(cloneOrErr) } end
local clone = cloneOrErr
if typeof(clone) ~= "Instance" then return { error = "Clone() returned nil (the source may not be Archivable)." } end

local parented = false
${
  parentPath !== undefined
    ? `do
  local parent, perr = __eval(${q(parentPath)})
  if perr then return { error = "clone succeeded but parentPath failed: " .. perr } end
  if typeof(parent) ~= "Instance" then return { error = "clone succeeded but parentPath did not resolve to an Instance (got " .. typeof(parent) .. ")." } end
  local okPar, parErr = pcall(function() clone.Parent = parent end)
  if not okPar then return { error = "clone succeeded but failed to parent it: " .. tostring(parErr) } end
  parented = true
end`
    : ""
}

local clonePath = clone.Name
local okCloneName, cloneFull = pcall(function() return clone:GetFullName() end)
if okCloneName then clonePath = cloneFull end

return {
  Source = srcPath,
  Clone = clonePath,
  Parented = parented,
  ClassName = clone.ClassName,
  ok = true,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
