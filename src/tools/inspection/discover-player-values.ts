import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Walks the usual hiding spots for "what's my money/xp/score?" — LocalPlayer
 * (esp. leaderstats), PlayerGui, ReplicatedStorage, ReplicatedFirst — and
 * surfaces every Value-class instance with a heuristic score. The AI gets a
 * single ranked list of candidate paths instead of grinding through the tree.
 *
 * The scoring is intentionally simple and explainable:
 *   - Name keyword (money/coin/cash/gold/score/xp/level/...) is the strongest signal.
 *   - leaderstats lives are weighted heavily — it's the canonical Roblox display.
 *   - Numeric kinds (Int/Number) beat String/Bool when keywords match.
 *   - Larger magnitudes get a small bias (scores tend to be big numbers).
 */
export default defineTool({
  name: "discover-player-values",
  title: "Discover Candidate Money / Score / Level Value Paths",
  description:
    "Auto-discovery for 'where's the money/score/XP path?'. Walks LocalPlayer (esp. leaderstats), PlayerGui, " +
    "ReplicatedStorage and ReplicatedFirst for IntValue/NumberValue/StringValue/BoolValue/Folder-of-values, " +
    "scores each by name keywords (money/coin/cash/gold/score/xp/level/exp/kills/wins/...), container weight " +
    "(leaderstats >> everything else), kind (numeric > string > bool), and magnitude. Returns a single ranked " +
    "list of { path, class, name, value, score, reasons[] } so the AI doesn't have to grind through the tree. " +
    "Pure read; no remotes fired, no state mutated. Use this as the first probe on any unfamiliar game.",
  category: "Inspection",
  mutatesState: false,
  input: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Maximum candidates to return, ranked by score (default 50)."),
    minScore: z
      .number()
      .optional()
      .describe("Drop candidates below this score; default 0 returns everything."),
    extraRoots: z
      .array(z.string())
      .optional()
      .describe(
        "Additional Luau path expressions to scan, e.g. ['game.Workspace.GameValues']. " +
          "Defaults already cover LocalPlayer/leaderstats/PlayerGui/ReplicatedStorage/ReplicatedFirst.",
      ),
  }),
  async execute({ limit, minScore, extraRoots }, ctx) {
    const lim = limit ?? 50;
    const floor = minScore ?? 0;
    const extras = (extraRoots ?? []).filter((s) => typeof s === "string" && s.length > 0);
    const extrasLua = extras.length
      ? "{" + extras.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",") + "}"
      : "{}";

    const source = `
local Players = game:GetService("Players")
local local_player = Players.LocalPlayer

-- Roots to walk, each with a static weight applied to all descendants below it.
local roots = {}
local function add(root, weight, label)
  if root then roots[#roots + 1] = { inst = root, weight = weight, label = label } end
end
if local_player then
  pcall(function() add(local_player:FindFirstChild("leaderstats"), 200, "leaderstats") end)
  pcall(function() add(local_player, 60, "Player") end)
  pcall(function() add(local_player:FindFirstChild("PlayerGui"), 25, "PlayerGui") end)
  pcall(function() add(local_player:FindFirstChild("PlayerScripts"), 10, "PlayerScripts") end)
end
pcall(function() add(game:GetService("ReplicatedStorage"), 40, "ReplicatedStorage") end)
pcall(function() add(game:GetService("ReplicatedFirst"), 30, "ReplicatedFirst") end)

-- Caller-supplied extras (Luau path expressions, loadstring'd).
for _, extra in ipairs(${extrasLua}) do
  local fn, _ = loadstring("return " .. extra)
  if fn then
    local ok, v = pcall(fn)
    if ok and typeof(v) == "Instance" then add(v, 35, extra) end
  end
end

-- Keyword buckets with weights.
local KEYWORDS = {
  { 100, "money" }, { 100, "coin" }, { 100, "cash" }, { 95, "gold" }, { 90, "gem" },
  { 95, "score" }, { 90, "xp" }, { 90, "exp" }, { 85, "level" }, { 80, "rank" },
  { 80, "kill" }, { 70, "death" }, { 75, "win" }, { 60, "loss" }, { 65, "rebirth" },
  { 65, "diamond" }, { 60, "token" }, { 55, "stat" }, { 50, "point" }, { 60, "credit" },
}
local function keywordScore(name)
  local low = string.lower(name or "")
  local best, reasons = 0, {}
  for _, e in ipairs(KEYWORDS) do
    if string.find(low, e[2], 1, true) then
      if e[1] > best then best = e[1] end
      reasons[#reasons + 1] = "name:" .. e[2]
    end
  end
  return best, reasons
end

local VALUE_KINDS = {
  IntValue = 1, NumberValue = 1, BoolValue = 0.5, StringValue = 0.5,
  CFrameValue = 0.4, Vector3Value = 0.4, Color3Value = 0.3, BrickColorValue = 0.3,
  ObjectValue = 0.5, RayValue = 0.3,
}

local out, seenPath = {}, {}
local function visit(inst, rootWeight, rootLabel, depth)
  if depth > 8 then return end
  local children
  local okc, c = pcall(function() return inst:GetChildren() end)
  if not okc then return end
  children = c
  for _, child in ipairs(children) do
    pcall(function()
      local cls = child.ClassName
      local kindWeight = VALUE_KINDS[cls]
      if kindWeight then
        local nm = child.Name or ""
        local kwScore, reasons = keywordScore(nm)
        local val, magnitude = nil, 0
        local okv, raw = pcall(function() return child.Value end)
        if okv then
          val = raw
          if type(raw) == "number" then magnitude = math.log(math.abs(raw) + 2) * 4 end
        end
        local score = rootWeight + kwScore + kindWeight * 30 + magnitude
        local fullName
        local okn, n = pcall(function() return child:GetFullName() end)
        fullName = okn and n or (rootLabel .. "." .. nm)
        if not seenPath[fullName] and score >= ${floor} then
          seenPath[fullName] = true
          if rootLabel == "leaderstats" then reasons[#reasons + 1] = "leaderstats" end
          out[#out + 1] = {
            path = fullName,
            name = nm,
            class = cls,
            value = (type(val) == "number" or type(val) == "string" or type(val) == "boolean") and val or tostring(val),
            score = math.floor(score),
            reasons = reasons,
            root = rootLabel,
          }
        end
      end
      -- Recurse into Folder/Configuration/etc. to find nested value bundles.
      visit(child, rootWeight, rootLabel, depth + 1)
    end)
  end
end

for _, r in ipairs(roots) do
  visit(r.inst, r.weight, r.label, 0)
end

-- Sort by score descending; cap to limit.
table.sort(out, function(a, b) return a.score > b.score end)
local capped = {}
for i = 1, math.min(${lim}, #out) do capped[i] = out[i] end
return { ok = true, total = #out, returned = #capped, candidates = capped }
`;

    const data = await ctx.runLuau(source, { timeoutMs: 15000 });
    return { data };
  },
});
