import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "cache-replace",
  title: "cache.replace — swap one instance for another in the executor cache",
  description:
    "Replace the executor's cached reference for one Instance with another via cache.replace(a, b). After the swap, " +
    "every script that indexes instance A through the cache transparently receives instance B instead — a powerful " +
    "redirection primitive for impersonating one object with another (e.g. pointing a checkpoint, hitbox, or remote " +
    "wrapper at a substitute you control). Both targets are resolved from Luau path/expressions via " +
    "loadstring('return ' .. expr). " +
    "Requires the cache library (type(cache)=='table') with cache.replace — both are " +
    "type-guarded and the call is pcall-wrapped, returning { error } when missing or on failure. Mutates live " +
    "executor state. Returns { ok } or { error }.",
  category: "Memory Scan",
  mutatesState: true,
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Luau path/expression resolving to the Instance whose cached reference is replaced (A). Evaluated as " +
          "`return <expression>`.",
      ),
    replacementPath: z
      .string()
      .describe(
        "Luau path/expression resolving to the Instance to substitute in (B). Evaluated as `return <expression>`.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ instancePath, replacementPath, threadContext, timeoutMs }, ctx) {
    const source = `
if type(cache) ~= "table" then
  return { error = "cache is not available in this executor." }
end
if type(cache.replace) ~= "function" then
  return { error = "cache.replace is not available in this executor." }
end

local loader = loadstring or load
if type(loader) ~= "function" then
  return { error = "loadstring/load is not available in this executor." }
end

local function __resolveInstance(expr)
  local okc, chunk = pcall(loader, "return " .. expr)
  if not okc or type(chunk) ~= "function" then
    return nil, "Failed to compile expression: " .. tostring(chunk)
  end
  local okr, inst = pcall(chunk)
  if not okr then
    return nil, "Error evaluating expression: " .. tostring(inst)
  end
  if typeof(inst) ~= "Instance" then
    return nil, "Expression did not resolve to an Instance (got " .. typeof(inst) .. ")."
  end
  return inst
end

local a, errA = __resolveInstance(${q(instancePath)})
if not a then return { error = "instancePath: " .. errA } end
local b, errB = __resolveInstance(${q(replacementPath)})
if not b then return { error = "replacementPath: " .. errB } end

local ok, err = pcall(cache.replace, a, b)
if not ok then
  return { error = "cache.replace failed: " .. tostring(err) }
end
return { ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
