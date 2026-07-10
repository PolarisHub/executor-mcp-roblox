import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "discover-character",
  title: "Discover a standard or custom character model",
  description:
    "Find the active player's character even when Players.LocalPlayer.Character, Humanoid, or HumanoidRootPart is " +
    "missing or custom-named. Checks the normal hierarchy first, then performs a bounded Workspace model search for " +
    "Humanoids and likely root parts. Use this after get-local-player-info reports a missing character; consume the " +
    "returned resolved paths instead of assuming game.Players.LocalPlayer.Character.HumanoidRootPart.",
  category: "Session & Client",
  input: z.object({
    playerName: z
      .string()
      .optional()
      .describe("Player name to inspect; defaults to Players.LocalPlayer."),
    scanWorkspace: z
      .boolean()
      .optional()
      .default(true)
      .describe("Search Workspace for custom models when the standard character is missing."),
    limit: z
      .number()
      .int()
      .positive()
      .max(3000)
      .optional()
      .default(1000)
      .describe("Maximum Workspace instances examined during fallback search."),
    threadContext: z.number().int().optional(),
  }),
  async execute({ playerName, scanWorkspace, limit, threadContext }, ctx) {
    const safeLimit = Math.max(1, Math.min(3000, Math.floor(limit)));
    const targetExpression = playerName
      ? `Players:FindFirstChild(${q(playerName)})`
      : "Players.LocalPlayer";
    const source = `
local limit = ${safeLimit}
local okPlayers, Players = pcall(function() return game:GetService("Players") end)
if not okPlayers or typeof(Players) ~= "Instance" then
  return { ok = false, error = "Players service is unavailable." }
end

local target = nil
pcall(function() target = ${targetExpression} end)
local candidates = {}
local seen = {}
local function pathOf(instance)
  local ok, value = pcall(function() return instance:GetFullName() end)
  return ok and value or tostring(instance)
end
local function findRoot(model)
  for _, name in ipairs({ "HumanoidRootPart", "RootPart", "LowerTorso", "Torso" }) do
    local ok, found = pcall(function() return model:FindFirstChild(name, true) end)
    if ok and found then return found, name end
  end
  local okPrimary, primary = pcall(function() return model.PrimaryPart end)
  if okPrimary and primary then return primary, "PrimaryPart" end
  return nil, nil
end
local function addCandidate(model, sourceName)
  if not model or not model:IsA("Model") then return end
  local key = pathOf(model)
  if seen[key] then return end
  local okHum, humanoid = pcall(function() return model:FindFirstChildOfClass("Humanoid") end)
  local root, rootKind = findRoot(model)
  if (okHum and humanoid) or root then
    seen[key] = true
    candidates[#candidates + 1] = {
      model = key,
      source = sourceName,
      humanoid = humanoid and pathOf(humanoid) or nil,
      rootPart = root and pathOf(root) or nil,
      rootKind = rootKind,
      complete = humanoid ~= nil and root ~= nil,
    }
  end
end

local standard = nil
if target then pcall(function() standard = target.Character end) end
addCandidate(standard, "Player.Character")

if ${scanWorkspace ? "true" : "false"} and #candidates == 0 then
  local queue, head, scanned = {}, 1, 1
  pcall(function() queue = workspace:GetChildren() end)
  while head <= #queue and scanned <= limit do
    local instance = queue[head]; head = head + 1; scanned = scanned + 1
    if instance:IsA("Model") then addCandidate(instance, "Workspace search") end
    if #candidates >= 25 then break end
    local okChildren, children = pcall(function() return instance:GetChildren() end)
    if okChildren then
      for _, child in ipairs(children) do
        if #queue >= limit then break end
        queue[#queue + 1] = child
      end
    end
  end
end

table.sort(candidates, function(a, b)
  if a.complete ~= b.complete then return a.complete end
  return (a.source == "Player.Character")
end)
local best = candidates[1]
return {
  ok = true,
  player = target and target.Name or nil,
  standardCharacter = standard and pathOf(standard) or nil,
  found = best ~= nil,
  resolved = best,
  candidates = candidates,
  scanned = limit,
  hint = best and "Use resolved.model, resolved.humanoid, and resolved.rootPart for follow-up tools." or "No candidate found; inspect Workspace or game-specific controller objects with search-instances/script.",
}
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return {
      data,
      summary: "Character discovery searched the standard path and bounded custom-model fallbacks.",
    };
  },
});
