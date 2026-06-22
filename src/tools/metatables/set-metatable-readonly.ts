import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "set-metatable-readonly",
  title: "Toggle a metatable's read-only flag (MUTATES live state)",
  description:
    "WRITES LIVE GAME STATE. DANGER — Resolve a Luau expression to a metatable (usually getrawmetatable(obj)) and " +
    "flip its read-only flag via setreadonly. Most game metatables (e.g. getrawmetatable(game)) are locked read-only " +
    "so __index/__namecall cannot be overwritten. Pass readonly=false to temporarily unlock a metatable so you can " +
    "edit a metamethod (or run hook-metamethod), then call this again with readonly=true to RE-LOCK it — leaving a " +
    "core metatable writable is a classic anticheat tripwire and can crash or destabilize the game. This changes the " +
    "live runtime; it does not create a copy. Requires setreadonly. Because it mutates state you MUST pass confirm=true; " +
    "otherwise the tool refuses and does nothing. Returns { Target, ReadOnly, ok } or { error }.",
  category: "Metatables & Closures",
  mutatesState: true,
  input: z.object({
    targetPath: z
      .string()
      .describe(
        "Luau expression resolving to the metatable (a table) whose read-only flag you want to change, e.g. " +
          "'getrawmetatable(game)', 'getrawmetatable(game.Players.LocalPlayer)', or 'getgenv().SomeLockedTable'. " +
          "Evaluated as `return <targetPath>`. Should resolve to a table — non-tables will error.",
      ),
    readonly: z
      .boolean()
      .describe(
        "The new read-only state. false = unlock the metatable so its metamethods can be edited/hooked; " +
          "true = re-lock it. Always re-lock when you are done to avoid leaving the game in an unprotected, " +
          "anticheat-suspicious state.",
      ),
    confirm: z
      .boolean()
      .describe(
        "Safety gate. Must be exactly true to apply the change. If omitted or false the tool refuses and does nothing, " +
          "because toggling read-only on a live metatable can destabilize the game or trip anticheat.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ targetPath, readonly, confirm, threadContext }, ctx) {
    if (confirm !== true) {
      return {
        data: { error: "Refusing to change a live metatable's read-only flag; pass confirm=true." },
        isError: true,
      };
    }

    const source = `
${REFLECT_PRELUDE}
if type(setreadonly) ~= "function" then return { error = "setreadonly is not available in this executor." } end
local target, err = __eval(${q(targetPath)})
if err then return { error = err } end
if type(target) ~= "table" then return { error = "targetPath did not resolve to a table (got " .. typeof(target) .. "); pass a metatable, e.g. getrawmetatable(game)." } end

local desired = ${readonly ? "true" : "false"}
local okSet, setErr = pcall(setreadonly, target, desired)
if not okSet then return { error = "setreadonly failed: " .. tostring(setErr) } end

local nowReadOnly = desired
if type(isreadonly) == "function" then
  local okR, r = pcall(isreadonly, target)
  if okR then nowReadOnly = r end
end

return {
  Target = ${q(targetPath)},
  ReadOnly = nowReadOnly,
  ok = true,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
