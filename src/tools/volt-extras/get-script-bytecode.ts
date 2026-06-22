import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Dump the compiled Luau bytecode of a script via the executor's getscriptbytecode.
 * The target script is resolved from a Luau expression (e.g. a path to a
 * LuaSourceContainer) through loadstring("return " .. expr); the raw bytecode string
 * is then returned as a byte count plus a short hex preview of its leading bytes —
 * the full blob is intentionally not shipped across the bridge.
 */
export default defineTool({
  name: "get-script-bytecode",
  title: "getscriptbytecode — dump a script's compiled bytecode",
  description:
    "Retrieve the compiled Luau bytecode for a script via the executor's getscriptbytecode. The script is resolved " +
    "from a Luau expression (typically a path to a LuaSourceContainer, e.g. " +
    "'game.ReplicatedStorage.Module') via loadstring('return ' .. expr). Returns the total byte count and a hex " +
    "preview of the first `previewBytes` bytes (the full bytecode is not shipped across the bridge). " +
    "Requires getscriptbytecode — type-guarded and pcall-wrapped, returning { error } when " +
    "missing or on failure. Returns { byteCount, hexPreview } or { error }.",
  category: "Reverse Engineering",
  input: z.object({
    scriptPath: z
      .string()
      .describe(
        "Luau expression resolving to a LuaSourceContainer, e.g. 'game.ReplicatedStorage.Module'. " +
          "Evaluated as `return <expression>`.",
      ),
    previewBytes: z
      .number()
      .int()
      .describe("How many leading bytecode bytes to include as a hex preview (default 64).")
      .optional()
      .default(64),
    threadContext: z.number().int().optional(),
  }),
  async execute({ scriptPath, previewBytes, threadContext }, ctx) {
    const preview = Math.min(Math.max(Math.floor(previewBytes), 0), 4096);
    const source = `
if type(getscriptbytecode) ~= "function" then
  return { error = "getscriptbytecode is not available in this executor." }
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

local ok, bytecode = pcall(getscriptbytecode, script)
if not ok then
  return { error = "getscriptbytecode failed: " .. tostring(bytecode) }
end
if type(bytecode) ~= "string" then
  return { error = "getscriptbytecode did not return a string (got " .. type(bytecode) .. ")." }
end

local n = math.min(#bytecode, ${preview})
local hex = {}
for i = 1, n do hex[i] = string.format("%02x", string.byte(bytecode, i)) end
return { byteCount = #bytecode, hexPreview = table.concat(hex) }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
