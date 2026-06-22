import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "set-rawmetatable",
  title: "Replace an object's raw metatable (MUTATES live state)",
  description:
    "WRITES LIVE GAME STATE. DANGER — Resolve a Luau expression to an object (table/Instance/userdata) and REPLACE " +
    "its entire metatable via setrawmetatable, bypassing any __metatable lock. This swaps out __index/__namecall/" +
    "__newindex etc. wholesale, so it can completely change how the object behaves — overwriting the game's core " +
    "metatable can break the client, sever security routing, and is a strong anticheat signal. Typical RE use: clone " +
    "the existing metatable, modify a metamethod, then set it back. Note the target metatable may need to be writable " +
    "(see set-metatable-readonly) before this succeeds. This changes the live runtime in place. Requires " +
    "setrawmetatable. Because it mutates state you MUST pass confirm=true; otherwise the tool refuses and does " +
    "nothing. Returns { Target, ok } or { error }.",
  category: "Metatables & Closures",
  mutatesState: true,
  input: z.object({
    objectPath: z
      .string()
      .describe(
        "Luau expression resolving to the object whose metatable you want to replace, e.g. 'game', " +
          "'game.Players.LocalPlayer', or 'getgenv().SomeProxy'. Evaluated as `return <objectPath>`.",
      ),
    metatableExpr: z
      .string()
      .describe(
        "Raw Luau expression evaluating to the NEW metatable (a table) to install, e.g. " +
          "'{ __index = function() return nil end }', 'setmetatable({}, nil)', or a previously cloned/edited " +
          "table referenced from getgenv(). Evaluated as `return <metatableExpr>`; must resolve to a table or nil.",
      ),
    confirm: z
      .boolean()
      .describe(
        "Safety gate. Must be exactly true to apply the change. If omitted or false the tool refuses and does nothing, " +
          "because replacing a live object's metatable can break the game or trip anticheat.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ objectPath, metatableExpr, confirm, threadContext }, ctx) {
    if (confirm !== true) {
      return {
        data: { error: "Refusing to replace a live object's raw metatable; pass confirm=true." },
        isError: true,
      };
    }

    const source = `
${REFLECT_PRELUDE}
if type(setrawmetatable) ~= "function" then return { error = "setrawmetatable is not available in this executor." } end
local obj, objErr = __eval(${q(objectPath)})
if objErr then return { error = objErr } end

local mt, mtErr = __eval(${q(metatableExpr)})
if mtErr then return { error = "metatableExpr: " .. mtErr } end
if mt ~= nil and type(mt) ~= "table" then return { error = "metatableExpr did not resolve to a table or nil (got " .. typeof(mt) .. ")." } end

local okSet, setErr = pcall(setrawmetatable, obj, mt)
if not okSet then return { error = "setrawmetatable failed: " .. tostring(setErr) } end

return {
  Target = ${q(objectPath)},
  ok = true,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
