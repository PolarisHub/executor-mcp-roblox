import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "cache-is-cached",
  title: "cache.iscached — check whether an instance is in the executor cache (Volt)",
  description:
    "Report whether the executor currently holds a cached reference for a single Instance via cache.iscached(inst). " +
    "Pairs with cache-invalidate / cache-replace: use it to confirm an instance is cached before invalidating it, or " +
    "to verify that an invalidate actually dropped the cached reference. The target is resolved from a Luau path/" +
    "expression via loadstring('return ' .. expr). Read-only. " +
    "Requires a Volt-class executor exposing the cache library (type(cache)=='table') with cache.iscached — both are " +
    "type-guarded and the call is pcall-wrapped, returning { error } when missing or on failure. Returns { cached } " +
    "or { error }.",
  category: "Memory Scan",
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau path/expression resolving to the Instance to check, e.g. 'game.Workspace.Boss'. Evaluated as " +
          "`return <expression>`.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ instancePath, threadContext, timeoutMs }, ctx) {
    const source = `
if type(cache) ~= "table" then
  return { error = "cache is not available in this executor." }
end
if type(cache.iscached) ~= "function" then
  return { error = "cache.iscached is not available in this executor." }
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

local ok, cached = pcall(cache.iscached, inst)
if not ok then
  return { error = "cache.iscached failed: " .. tostring(cached) }
end
return { cached = cached == true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
