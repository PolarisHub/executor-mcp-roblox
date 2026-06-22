import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "get-script-content",
  title: "Get the content of a script in the Roblox Game Client",
  description:
    "Get decompiled source for a Roblox script by path or getter code. Use startLine/endLine for a focused range when the full script is large.",
  category: "Inspection",
  input: z.object({
    scriptGetterSource: z
      .string()
      .describe(
        "The code that fetches the script object from the game (should return a script object, and MUST be client-side only, will not work on Scripts with RunContext set to Server)",
      )
      .optional(),
    scriptPath: z
      .string()
      .describe("The path to the script to get the content of (e.g. 'game.Workspace.MyScript').")
      .optional(),
    startLine: z
      .number()
      .int()
      .describe(
        "Optional start line number (1-based) to return only a range of lines from the decompiled script. If omitted, returns the full script.",
      )
      .optional(),
    endLine: z
      .number()
      .int()
      .describe(
        "Optional end line number (1-based, inclusive) to return only a range of lines. Defaults to end of script if startLine is set but endLine is omitted.",
      )
      .optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ scriptGetterSource, scriptPath, startLine, endLine, threadContext }, ctx) {
    if (scriptGetterSource === undefined && scriptPath === undefined) {
      return {
        data: { error: "Must provide either scriptGetterSource or scriptPath." },
        isError: true,
      };
    }
    if (scriptGetterSource !== undefined && scriptPath !== undefined) {
      return {
        data: { error: "Must provide either scriptGetterSource or scriptPath, not both." },
        isError: true,
      };
    }

    const getter = scriptGetterSource ?? `return ${scriptPath}`;
    const startExpr = startLine !== undefined ? String(Math.floor(startLine)) : "nil";
    const endExpr = endLine !== undefined ? String(Math.floor(endLine)) : "nil";

    const source = `
if type(decompile) ~= "function" then
  return { error = "decompile is not available in this executor." }
end

local getter, gErr = loadstring(${q(getter)})
if not getter then
  return { error = "Failed to compile script getter: " .. tostring(gErr) }
end
local okGet, scriptInstance = pcall(getter)
if not okGet then
  return { error = "Script getter errored: " .. tostring(scriptInstance) }
end
if typeof(scriptInstance) ~= "Instance" then
  return { error = "Script getter did not return an Instance (got " .. typeof(scriptInstance) .. ")." }
end
if not scriptInstance:IsA("LuaSourceContainer") then
  return { error = "Resolved instance is not a LuaSourceContainer (Script, LocalScript, or ModuleScript)." }
end
if scriptInstance:IsA("Script") and scriptInstance.RunContext == Enum.RunContext.Server then
  return { error = "Resolved instance is a server Script; only client-side scripts can be decompiled." }
end

local okSrc, src = pcall(function() return decompile(scriptInstance) end)
if not okSrc or type(src) ~= "string" then
  return { error = "Failed to decompile script: " .. tostring(src) }
end

local startLine = ${startExpr}
local endLine = ${endExpr}
local fullName = scriptInstance:GetFullName()

if startLine then
  local lines = {}
  local pos = 1
  local len = #src
  while pos <= len do
    local nl = src:find("\\n", pos, true)
    if nl then
      table.insert(lines, src:sub(pos, nl - 1))
      pos = nl + 1
    else
      table.insert(lines, src:sub(pos))
      break
    end
  end
  local totalLines = #lines
  local s = math.max(1, math.min(startLine, totalLines))
  local e = endLine and math.max(s, math.min(endLine, totalLines)) or totalLines
  local sliced = {}
  for i = s, e do table.insert(sliced, lines[i]) end
  return {
    path = fullName,
    className = scriptInstance.ClassName,
    startLine = s,
    endLine = e,
    totalLines = totalLines,
    source = "-- Lines " .. s .. "-" .. e .. " of " .. totalLines .. "\\n" .. table.concat(sliced, "\\n"),
  }
end

return { path = fullName, className = scriptInstance.ClassName, source = src }
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 60000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
