import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { HIDDEN_PRELUDE } from "../_shared/hidden.js";

export default defineTool({
  name: "find-hidden-scripts",
  title: "Find scripts that are hiding",
  description:
    "Scan ALL scripts (getscripts) and currently-running scripts (getrunningscripts) and report the ones that are " +
    "trying to hide — i.e. not sitting normally in the game tree: nil-parented, detached from the DataModel, running " +
    "inside an Actor (parallel-Luau VM), living in CoreGui, or destroyed-but-still-executing. Each result gives the " +
    "script's name, class, where it actually lives, and whether it is currently running. This is the go-to tool for " +
    "finding malicious/obfuscated/anti-detection scripts that hide outside the normal hierarchy. Requires " +
    "getscripts/getrunningscripts; degrades with a clear error otherwise.",
  category: "Actors & Hidden",
  input: z.object({
    maxScan: z
      .number()
      .int()
      .describe(
        "Max scripts to examine from getscripts (default 6000). Running scripts are always checked first.",
      )
      .optional()
      .default(6000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ maxScan, threadContext }, ctx) {
    const cap = Math.min(Math.max(Math.floor(maxScan), 1), 20000);
    const source = `
${HIDDEN_PRELUDE}
if type(getscripts) ~= "function" and type(getrunningscripts) ~= "function" then
  return { error = "getscripts/getrunningscripts are not available in this executor." }
end

local results = {}
local seen = {}
local running = {}
local okR, rs = pcall(getrunningscripts)
if okR and type(rs) == "table" then for _, s in rs do running[s] = true end end

local function consider(s)
  if seen[s] then return end
  seen[s] = true
  if not __isA(s, "LuaSourceContainer") then return end
  local loc = __location(s)
  local isRunning = running[s] == true
  -- "hiding" = not a normal in-tree script, OR a running script with no live parent.
  if loc ~= "in tree" or (isRunning and __parent(s) == nil) then
    results[#results + 1] = {
      name = __name(s),
      class = __class(s),
      location = loc,
      running = isRunning,
      fullName = __fullName(s),
    }
  end
end

if okR and type(rs) == "table" then for _, s in rs do consider(s) end end
local okS, all = pcall(getscripts)
if okS and type(all) == "table" then
  local n = 0
  for _, s in all do
    n = n + 1
    if n > ${cap} then break end
    consider(s)
  end
end

local out = {}
for i = 1, math.min(#results, 300) do out[i] = results[i] end
return { hiddenCount = #results, truncated = #results > 300, scripts = out }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
