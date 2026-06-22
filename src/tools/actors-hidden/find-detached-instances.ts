import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { HIDDEN_PRELUDE, q } from "../_shared/hidden.js";

export default defineTool({
  name: "find-detached-instances",
  title: "Find detached instances (in registry, off the DataModel)",
  description:
    "Walk every instance the executor can see (getinstances) and report the ones that are DETACHED from the running " +
    "game — i.e. they exist in the executor's instance registry but pcall(inst.IsDescendantOf, inst, game) returns " +
    "false, so they are not reachable from the DataModel. This catches objects that were Destroy()'d or reparented to " +
    "nil yet kept alive by a lingering reference, plus anything an anti-detection script has stashed off the hierarchy. " +
    "An optional className filter narrows the walk to a single ClassName (matched via IsA so subclasses are included). " +
    "Unlike find-hidden-instances (which uses an ancestor-walk to test reachability), this tool uses IsDescendantOf " +
    "against game directly, supports a class filter, and always reports a full byClass breakdown across ALL detached " +
    "instances. Returns { totalDetached, byClass, truncated, samples: [{ class, name }] }. Requires getinstances; " +
    "degrades with a clear error otherwise.",
  category: "Actors & Hidden",
  input: z.object({
    className: z
      .string()
      .describe(
        "Optional ClassName to filter to, e.g. 'RemoteEvent', 'LocalScript', 'ScreenGui', 'Part'. Matched with " +
          "inst:IsA(className) so subclasses are included. Omit to report detached instances of every class.",
      )
      .optional(),
    limit: z
      .number()
      .int()
      .describe(
        "Max number of detailed sample instances to return in the samples list (default 200, clamped to 2000). The " +
          "totalDetached count and byClass tally always cover every detached instance found regardless of this limit.",
      )
      .optional()
      .default(200),
    maxScan: z
      .number()
      .int()
      .describe(
        "Max number of instances to examine from getinstances() before stopping (default 60000, clamped to 500000). " +
          "Protects against huge games; if hit, `truncated` is set true.",
      )
      .optional()
      .default(60000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ className, limit, maxScan, threadContext }, ctx) {
    const hasFilter = typeof className === "string" && className.trim().length > 0;
    const sampleCap = Math.min(Math.max(Math.floor(limit), 1), 2000);
    const scanCap = Math.min(Math.max(Math.floor(maxScan), 1), 500000);
    const source = `
${HIDDEN_PRELUDE}
if type(getinstances) ~= "function" then
  return { error = "getinstances is not available in this executor." }
end

local okI, all = pcall(getinstances)
if not okI or type(all) ~= "table" then
  return { error = "getinstances() call failed or returned no table." }
end

local SAMPLE_CAP = ${sampleCap}
local SCAN_CAP = ${scanCap}
local hasFilter = ${hasFilter ? "true" : "false"}
local filterClass = ${hasFilter ? q(className ?? "") : "nil"}

local totalDetached = 0
local scanned = 0
local truncated = false
local byClass = {}
local samples = {}

-- Detached = exists in the registry but not a descendant of game.
local function isDetached(inst)
  local ok, res = pcall(function() return inst:IsDescendantOf(game) end)
  if not ok then
    -- Could not even test it; treat as detached/suspect rather than dropping it.
    return true
  end
  return res == false
end

for _, inst in all do
  scanned = scanned + 1
  if scanned > SCAN_CAP then
    truncated = true
    break
  end
  if hasFilter and not __isA(inst, filterClass) then
    -- skip; not the class we are filtering for
  else
    if isDetached(inst) then
      totalDetached = totalDetached + 1
      local cls = __class(inst)
      byClass[cls] = (byClass[cls] or 0) + 1
      if #samples < SAMPLE_CAP then
        samples[#samples + 1] = {
          class = cls,
          name = __name(inst),
        }
      end
    end
  end
end

if totalDetached > #samples then truncated = true end

return {
  totalDetached = totalDetached,
  scannedApprox = scanned,
  byClass = byClass,
  truncated = truncated,
  samples = samples,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
