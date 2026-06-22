import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "is-readonly",
  title: "Check whether a table/metatable is read-only",
  description:
    "Resolve a Luau expression to a table (or a metatable expression) and report whether it is locked read-only " +
    "via isreadonly. Roblox marks core metatables (e.g. getrawmetatable(game)) and many security tables read-only " +
    "so __index/__namecall can't be swapped; this tells you whether you'd need setreadonly(t, false) before any " +
    "mutation would take effect. Use it as a safe, non-mutating pre-check before attempting metatable hooks or " +
    "constant/upvalue edits — it changes nothing. Typical targets: a plain table from getgenv(), or " +
    "'getrawmetatable(game)' to confirm the global instance metatable is frozen. Requires isreadonly; returns " +
    "{ Target, TargetType, ReadOnly } or { error } when the value isn't a table or isreadonly is unavailable.",
  category: "Metatables & Closures",
  input: z.object({
    targetPath: z
      .string()
      .describe(
        "Luau expression resolving to the table or metatable to test, e.g. 'getgenv().SomeTable', " +
          "'getrawmetatable(game)', or 'getrawmetatable(game.Players.LocalPlayer)'. Evaluated as `return <targetPath>`. " +
          "isreadonly only applies to tables — userdata/Instances will report an error.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ targetPath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(isreadonly) ~= "function" then return { error = "isreadonly is not available in this executor." } end
local target, err = __eval(${q(targetPath)})
if err then return { error = err } end
if type(target) ~= "table" then return { error = "isreadonly only works on tables; expression resolved to " .. typeof(target) .. ": " .. ${q(targetPath)} } end

local okR, ro = pcall(isreadonly, target)
if not okR then return { error = "isreadonly failed: " .. tostring(ro) } end

return {
  Target = ${q(targetPath)},
  TargetType = typeof(target),
  ReadOnly = ro,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
