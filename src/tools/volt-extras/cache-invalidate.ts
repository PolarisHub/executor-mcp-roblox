import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "cache-invalidate",
  title: "cache.invalidate — drop an instance from the executor's instance cache",
  description:
    "Invalidate the executor's cached reference to a single Instance via cache.invalidate(inst). After invalidation " +
    "the next time the game indexes that instance it receives a FRESH reference rather than the cached one — the " +
    "classic technique for de-syncing a server-trusted object so your subsequent edits to the cached copy go " +
    "unnoticed, or for forcing the executor to re-wrap a part you have been tampering with. The target is resolved " +
    "from a Luau path/expression via loadstring('return ' .. expr). " +
    "Requires the cache library (type(cache)=='table') with cache.invalidate — both " +
    "are type-guarded and the call is pcall-wrapped, returning { error } when missing or on failure. Mutates live " +
    "executor state. Returns { ok } or { error }.",
  category: "Memory Scan",
  mutatesState: true,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau path/expression resolving to the Instance to invalidate, e.g. 'game.Workspace.Boss' or " +
          "'game.Players.LocalPlayer.Character.HumanoidRootPart'. Evaluated as `return <expression>`.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ instancePath, threadContext, timeoutMs }, ctx) {
    const source = `
if type(cache) ~= "table" then
  return { error = "cache is not available in this executor." }
end
if type(cache.invalidate) ~= "function" then
  return { error = "cache.invalidate is not available in this executor." }
end

local loader = loadstring or load
if type(loader) ~= "function" then
  return { error = "loadstring/load is not available in this executor." }
end
local okc, chunk = pcall(loader, "return " .. ${q(instancePath)})
if not okc or type(chunk) ~= "function" then
  return { error = "Failed to compile expression: " .. tostring(chunk) }
end
local okr, inst = pcall(chunk)
if not okr then
  return { error = "Error evaluating expression: " .. tostring(inst) }
end
if typeof(inst) ~= "Instance" then
  return { error = "Expression did not resolve to an Instance (got " .. typeof(inst) .. ")." }
end

local ok, err = pcall(cache.invalidate, inst)
if not ok then
  return { error = "cache.invalidate failed: " .. tostring(err) }
end
return { ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
