import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "restore-hook",
  title: "Restore (undo) a hook installed via this MCP",
  description:
    "WRITES LIVE GAME STATE. Undo a hook created by hook-function / hook-metamethod, restoring the captured original. Pass a `key` from " +
    "list-hooks to restore one, or `all: true` to restore every tracked hook. For function hooks it re-resolves the " +
    "target and calls restorefunction (falling back to re-hooking with the original); for metamethod hooks it " +
    "re-installs the original metamethod. Successfully restored hooks are removed from the registry. Use this to " +
    "clean up after debugging so your hooks don't linger and destabilize the game.",
  category: "Metatables & Closures",
  mutatesState: true,
  input: z.object({
    key: z
      .string()
      .describe("The hook key to restore (from list-hooks). Ignored when all=true.")
      .optional()
      .default(""),
    all: z
      .boolean()
      .describe("Restore ALL tracked hooks (ignores key). Default false.")
      .optional()
      .default(false),
    threadContext: z.number().int().optional(),
  }),
  async execute({ key, all, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor." } end
local genv = getgenv()
local hooks = genv.__mcp_hooks or {}
local meta = genv.__mcp_hook_meta or {}

local function restoreOne(k)
  local original = hooks[k]
  local m = meta[k]
  if original == nil then return false, "no stored original for this key" end
  if not m then return false, "no metadata for this key (cannot determine how to restore)" end
  if m.kind == "function" then
    local target, terr = __eval(m.targetExpr)
    if terr then return false, "could not re-resolve target: " .. terr end
    local ok, err = pcall(function()
      if type(restorefunction) == "function" then restorefunction(target)
      elseif type(hookfunction) == "function" then hookfunction(target, original)
      else error("no restorefunction/hookfunction available") end
    end)
    if not ok then return false, "restore failed: " .. tostring(err) end
  elseif m.kind == "metamethod" then
    if type(hookmetamethod) ~= "function" then return false, "hookmetamethod is not available" end
    local obj, oerr = __eval(m.targetExpr)
    if oerr then return false, "could not re-resolve object: " .. oerr end
    local ok, err = pcall(hookmetamethod, obj, m.method, original)
    if not ok then return false, "restore failed: " .. tostring(err) end
  else
    return false, "unknown hook kind: " .. tostring(m.kind)
  end
  hooks[k] = nil
  meta[k] = nil
  return true, nil
end

if ${all ? "true" : "false"} then
  local keys = {}
  for k in pairs(hooks) do keys[#keys + 1] = k end
  local results = {}
  for _, k in ipairs(keys) do
    local ok, err = restoreOne(k)
    results[#results + 1] = { Key = tostring(k), Restored = ok, Error = err }
  end
  return { RestoredAll = true, Count = #results, Results = results }
end

local key = ${q(key ?? "")}
if key == "" then return { error = "Provide a key (from list-hooks), or pass all=true." } end
local ok, err = restoreOne(key)
if not ok then return { error = err, Key = key } end
return { Restored = key, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 15000 });
    return { data };
  },
});
