import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { HIDDEN_PRELUDE } from "../_shared/hidden.js";

export default defineTool({
  name: "find-hidden-remotes",
  title: "Find hidden Remote / Bindable channels",
  description:
    "Find RemoteEvent / RemoteFunction / UnreliableRemoteEvent / BindableEvent / BindableFunction instances that are " +
    "NOT in the normal game tree — i.e. nil-parented or detached from the DataModel. A remote/bindable kept alive by a " +
    "reference but hidden off the hierarchy is a classic backdoor / data-exfiltration channel: an exploit or malicious " +
    "script fires it to phone home or to receive commands without the object ever appearing in the Explorer. This tool " +
    "pulls getnilinstances() (the primary source of nil-parented objects) and, when getinstances() is available, also " +
    "includes any remote/bindable that is not a descendant of `game`, deduping across both sources. It complements " +
    "get-nil-instances / find-hidden-instances by narrowing to just the communication-channel classes and giving a " +
    "ready-to-inspect list. Returns { count, byClass, truncated, samples: [{ class, name, location }] }, capped. " +
    "Requires getnilinstances (Volt-class executors); getinstances is used additionally when present. Degrades with a " +
    "clear error if neither is available.",
  category: "Actors & Hidden",
  input: z.object({
    limit: z
      .number()
      .int()
      .describe(
        "Max number of detailed sample remotes/bindables to return in the samples list (default 200, clamped to " +
          "2000). The count and byClass tally always cover every hidden remote/bindable found regardless of this limit.",
      )
      .optional()
      .default(200),
    maxScan: z
      .number()
      .int()
      .describe(
        "Max number of instances to examine from getinstances() before stopping the getinstances pass (default " +
          "60000, clamped to 500000). Protects against huge games; if hit, `truncated` is set true. The " +
          "getnilinstances pass is always fully scanned.",
      )
      .optional()
      .default(60000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, maxScan, threadContext }, ctx) {
    const sampleCap = Math.min(Math.max(Math.floor(limit), 1), 2000);
    const scanCap = Math.min(Math.max(Math.floor(maxScan), 1), 500000);
    const source = `
${HIDDEN_PRELUDE}
local hasNil = type(getnilinstances) == "function"
local hasAll = type(getinstances) == "function"
if not hasNil and not hasAll then
  return { error = "Neither getnilinstances nor getinstances is available in this executor." }
end

local SAMPLE_CAP = ${sampleCap}
local SCAN_CAP = ${scanCap}

-- Communication-channel classes we care about.
local WANT = {
  RemoteEvent = true,
  RemoteFunction = true,
  UnreliableRemoteEvent = true,
  BindableEvent = true,
  BindableFunction = true,
}

local function isWanted(inst)
  local cls = __class(inst)
  if WANT[cls] then return true, cls end
  -- Fall back to IsA so subclasses / odd ClassName reads are still caught.
  for c, _ in WANT do
    if __isA(inst, c) then return true, c end
  end
  return false, cls
end

local count = 0
local truncated = false
local byClass = {}
local samples = {}
local seen = {}

local function consider(inst)
  if inst == nil then return end
  if seen[inst] then return end
  seen[inst] = true
  -- Only count a remote/bindable as "hidden" if it is actually off the tree.
  local okHidden, hidden = pcall(function() return not __inTree(inst) end)
  if not okHidden or not hidden then return end
  local wanted, cls = isWanted(inst)
  if not wanted then return end
  count = count + 1
  byClass[cls] = (byClass[cls] or 0) + 1
  if #samples < SAMPLE_CAP then
    samples[#samples + 1] = {
      class = cls,
      name = __name(inst),
      location = __location(inst),
    }
  end
end

-- Pass 1: nil-parented instances (always fully scanned).
if hasNil then
  local okN, nils = pcall(getnilinstances)
  if okN and type(nils) == "table" then
    for _, inst in nils do
      consider(inst)
    end
  end
end

-- Pass 2: any remote/bindable in getinstances() that is not under game.
if hasAll then
  local okI, all = pcall(getinstances)
  if okI and type(all) == "table" then
    local scanned = 0
    for _, inst in all do
      scanned = scanned + 1
      if scanned > SCAN_CAP then
        truncated = true
        break
      end
      consider(inst)
    end
  end
end

if count > #samples then truncated = true end

return {
  count = count,
  byClass = byClass,
  truncated = truncated,
  samples = samples,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
