import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Dump the game (or a subtree) to a .rbxm/.rbxmx file in the executor workspace
 * via saveinstance. Executors vary wildly in the signature they accept, so we try
 * several best-effort forms: saveinstance({ FilePath = name }), then
 * saveinstance(instance, name) / saveinstance(instance), then saveinstance().
 */
export default defineTool({
  name: "save-instance",
  title: "Dump the game or a subtree to the workspace (sUNC saveinstance)",
  description:
    "WRITES HOST FILES — serializes the entire game (or a chosen instance subtree) to a file in the executor's " +
    "workspace folder via saveinstance. By default it dumps the whole DataModel; pass instancePath to dump just " +
    "that subtree. This is a heavy operation that can take a while and produce a large file. Because executors " +
    "differ on the exact signature, this tries several forms in order: saveinstance({ FilePath = fileName }), then " +
    "saveinstance(instance, fileName) / saveinstance(instance), then saveinstance(). Requires saveinstance. " +
    "The call is type-guarded and pcall-wrapped: if saveinstance is missing you " +
    "get { error = 'saveinstance is not available in this executor.' }. Returns { saved, note } or { error }.",
  category: "Utility",
  mutatesState: true,
  input: z.object({
    fileName: z
      .string()
      .optional()
      .describe(
        "Optional output file name within the executor workspace (e.g. 'place.rbxm'). Omit to let the executor pick a default.",
      ),
    instancePath: z
      .string()
      .optional()
      .describe(
        "Optional Luau expression for the instance to dump (e.g. 'game.Workspace'). Defaults to the whole game.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ fileName, instancePath, threadContext, timeoutMs }, ctx) {
    const fileNameLiteral = fileName === undefined ? "nil" : q(fileName);
    const instanceExpr = instancePath ?? "game";
    const source = `
if type(saveinstance) ~= "function" then
  return { error = "saveinstance is not available in this executor." }
end
local fileName = ${fileNameLiteral}
local instance = ${instanceExpr}

-- Try the several signatures executors use, in best-effort order.
local function attempt()
  if fileName ~= nil then
    local ok = pcall(saveinstance, { FilePath = fileName, path = fileName })
    if ok then return "saveinstance({ FilePath = fileName })" end
    ok = pcall(saveinstance, instance, fileName)
    if ok then return "saveinstance(instance, fileName)" end
  end
  local ok = pcall(saveinstance, instance)
  if ok then return "saveinstance(instance)" end
  ok = pcall(saveinstance)
  if ok then return "saveinstance()" end
  return nil
end

local ok, note = pcall(attempt)
if not ok then return { error = tostring(note) } end
if note == nil then return { error = "saveinstance failed for every attempted signature." } end
return { saved = true, note = note }
`;
    const data = await ctx.runLuau(source, {
      threadContext,
      timeoutMs: timeoutMs ?? 120000,
    });
    return { data };
  },
});
