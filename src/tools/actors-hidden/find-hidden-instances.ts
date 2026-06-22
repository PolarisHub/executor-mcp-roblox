import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { HIDDEN_PRELUDE } from "../_shared/hidden.js";

export default defineTool({
  name: "find-hidden-instances",
  title: "Find hidden / detached instances",
  description:
    "Enumerate EVERY instance the executor can see (getinstances — this includes objects that are not reachable from " +
    "the game DataModel) and report the ones that are hidden: nil-parented, detached from the game tree, or buried " +
    "inside an Actor / CoreGui. An instance is considered hidden when it is not reachable from `game` (__inTree is " +
    "false). Returns a per-class tally (byClass) plus a capped list of samples, each describing the instance's class, " +
    "name, full path, and exactly how it is hidden (location). This is the broadest sweep for anything an exploit/anti-" +
    "detection script has stashed off the normal hierarchy. Requires getinstances; degrades " +
    "with a clear error otherwise.",
  category: "Actors & Hidden",
  input: z.object({
    limit: z
      .number()
      .int()
      .describe(
        "Max number of detailed sample instances to return (default 500, clamped to 3000). The byClass tally always " +
          "counts every hidden instance found regardless of this limit.",
      )
      .optional()
      .default(500),
    maxScan: z
      .number()
      .int()
      .describe(
        "Max number of instances to examine from getinstances before stopping (default 60000). Protects against huge " +
          "games; if hit, `truncated` is set true and scannedApprox reflects how many were inspected.",
      )
      .optional()
      .default(60000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, maxScan, threadContext }, ctx) {
    const sampleCap = Math.min(Math.max(Math.floor(limit), 1), 3000);
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

local hiddenCount = 0
local scanned = 0
local truncated = false
local byClass = {}
local samples = {}

for _, inst in all do
  scanned = scanned + 1
  if scanned > SCAN_CAP then
    truncated = true
    break
  end
  local okHidden, isHidden = pcall(function() return not __inTree(inst) end)
  if okHidden and isHidden then
    hiddenCount = hiddenCount + 1
    local cls = __class(inst)
    byClass[cls] = (byClass[cls] or 0) + 1
    if #samples < SAMPLE_CAP then
      samples[#samples + 1] = {
        class = cls,
        name = __name(inst),
        fullName = __fullName(inst),
        location = __location(inst),
      }
    end
  end
end

if hiddenCount > #samples then truncated = true end

return {
  hiddenCount = hiddenCount,
  scannedApprox = scanned,
  truncated = truncated,
  byClass = byClass,
  samples = samples,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
