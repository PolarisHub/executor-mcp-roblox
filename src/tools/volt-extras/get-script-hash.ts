import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Return the content hash of a script via the executor's getscripthash. The target
 * is resolved from a Luau expression (a path to a LuaSourceContainer) through
 * loadstring("return " .. expr), then hashed — useful to detect when a script's
 * bytecode/source has changed between two observations.
 */
export default defineTool({
  name: "get-script-hash",
  title: "getscripthash — content hash of a script",
  description:
    "Compute the content hash of a script via the executor's getscripthash. The script is resolved from a Luau " +
    "expression (typically a path to a LuaSourceContainer, e.g. 'game.ReplicatedStorage.Module') via " +
    "loadstring('return ' .. expr). Handy for detecting when a script's bytecode/source changes between two checks. " +
    "Requires getscripthash — type-guarded and pcall-wrapped, returning { error } when missing " +
    "or on failure. Returns { hash } or { error }.",
  category: "Reverse Engineering",
  input: z.object({
    scriptPath: z
      .string()
      .describe(
        "Luau expression resolving to a LuaSourceContainer, e.g. 'game.ReplicatedStorage.Module'. " +
          "Evaluated as `return <expression>`.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ scriptPath, threadContext }, ctx) {
    const source = `
if type(getscripthash) ~= "function" then
  return { error = "getscripthash is not available in this executor." }
end

local loader = loadstring or load
if type(loader) ~= "function" then
  return { error = "loadstring/load is not available in this executor." }
end
local okc, chunk = pcall(loader, "return " .. ${q(scriptPath)})
if not okc or type(chunk) ~= "function" then
  return { error = "Failed to compile expression: " .. tostring(chunk) }
end
local okr, script = pcall(chunk)
if not okr then
  return { error = "Error evaluating expression: " .. tostring(script) }
end
if typeof(script) ~= "Instance" then
  return { error = "Expression did not resolve to an Instance (got " .. typeof(script) .. ")." }
end

local ok, hash = pcall(getscripthash, script)
if not ok then
  return { error = "getscripthash failed: " .. tostring(hash) }
end
return { hash = hash }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
