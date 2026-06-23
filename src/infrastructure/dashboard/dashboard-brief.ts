import { ClientNotFoundError } from "../../domain/errors/errors.js";
import { ClientId } from "../../domain/shared/ids.js";
import type { ClientDirectory } from "../../application/ports/client-directory.js";
import type { ExecutionGateway } from "../../application/ports/execution-gateway.js";

/**
 * Game Brief queries: a small one-shot read of the active place's identity +
 * top-level shape, and a wrapper around the discover-player-values tool's Luau
 * so the dashboard can trigger value discovery without going through the MCP
 * client.
 */
export class BriefService {
  constructor(
    private readonly gateway: ExecutionGateway,
    private readonly clients: ClientDirectory,
  ) {}

  private run(clientId: string, source: string, timeoutMs = 15000): Promise<unknown> {
    const id = ClientId(clientId);
    if (!this.clients.get(id)) {
      return Promise.reject(new ClientNotFoundError(`Client "${clientId}" is not connected.`));
    }
    return this.gateway.eval(id, { source, threadContext: 8, timeoutMs });
  }

  /** Place identity + a count of services that commonly host game logic. */
  summary(clientId: string): Promise<unknown> {
    const source = `
local out = { ok = true, place = {}, counts = {} }
pcall(function()
  out.place.placeId = game.PlaceId
  out.place.gameId = game.GameId
  out.place.placeVersion = game.PlaceVersion
  out.place.jobId = game.JobId
  out.place.creatorId = game.CreatorId
  out.place.creatorType = tostring(game.CreatorType)
  out.place.privateServerId = game.PrivateServerId
  out.place.privateServerOwnerId = game.PrivateServerOwnerId
end)
pcall(function()
  local Players = game:GetService("Players")
  out.place.maxPlayers = Players.MaxPlayers
  out.place.numPlayers = #Players:GetPlayers()
  local lp = Players.LocalPlayer
  if lp then
    out.player = { userId = lp.UserId, name = lp.Name, displayName = lp.DisplayName }
  end
end)

-- Count categories of common surfaces under top-level services. Small, bounded,
-- and gives the operator a quick scent of "is this a script-heavy place".
local function count(service, classes)
  local got = { total = 0 }
  for _, c in ipairs(classes) do got[c] = 0 end
  pcall(function()
    for _, d in ipairs(service:GetDescendants()) do
      local cn = d.ClassName
      for _, c in ipairs(classes) do
        if cn == c then
          got[c] = got[c] + 1
          got.total = got.total + 1
          break
        end
      end
    end
  end)
  return got
end

local Replicated = game:GetService("ReplicatedStorage")
out.counts.replicated = count(Replicated, { "RemoteEvent", "RemoteFunction", "BindableEvent", "BindableFunction", "ModuleScript" })

local Workspace = game:GetService("Workspace")
out.counts.workspace = count(Workspace, { "Script", "LocalScript", "Part", "MeshPart" })

local StarterPack = game:GetService("StarterPack")
out.counts.starterPack = count(StarterPack, { "Tool", "Script", "LocalScript" })

return out
`;
    return this.run(clientId, source, 10000);
  }

  /** Ranked candidate value paths — mirrors discover-player-values' heuristic. */
  values(clientId: string, limit: number): Promise<unknown> {
    const lim = Math.max(1, Math.min(200, Math.floor(limit)));
    const source = `
local Players = game:GetService("Players")
local local_player = Players.LocalPlayer

local roots = {}
local function add(root, weight, label)
  if root then roots[#roots + 1] = { inst = root, weight = weight, label = label } end
end
if local_player then
  pcall(function() add(local_player:FindFirstChild("leaderstats"), 200, "leaderstats") end)
  pcall(function() add(local_player, 60, "Player") end)
  pcall(function() add(local_player:FindFirstChild("PlayerGui"), 25, "PlayerGui") end)
end
pcall(function() add(game:GetService("ReplicatedStorage"), 40, "ReplicatedStorage") end)
pcall(function() add(game:GetService("ReplicatedFirst"), 30, "ReplicatedFirst") end)

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

local out, seen = {}, {}
local function visit(inst, rootWeight, rootLabel, depth)
  if depth > 8 then return end
  local okc, kids = pcall(function() return inst:GetChildren() end)
  if not okc then return end
  for _, child in ipairs(kids) do
    pcall(function()
      local cls = child.ClassName
      local kw = VALUE_KINDS[cls]
      if kw then
        local nm = child.Name or ""
        local kws, reasons = keywordScore(nm)
        local val, mag = nil, 0
        local okv, raw = pcall(function() return child.Value end)
        if okv then
          val = raw
          if type(raw) == "number" then mag = math.log(math.abs(raw) + 2) * 4 end
        end
        local score = rootWeight + kws + kw * 30 + mag
        local okn, full = pcall(function() return child:GetFullName() end)
        local path = okn and full or (rootLabel .. "." .. nm)
        if not seen[path] then
          seen[path] = true
          if rootLabel == "leaderstats" then reasons[#reasons + 1] = "leaderstats" end
          out[#out + 1] = {
            path = path,
            name = nm,
            class = cls,
            value = (type(val) == "number" or type(val) == "string" or type(val) == "boolean") and val or tostring(val),
            score = math.floor(score),
            reasons = reasons,
            root = rootLabel,
          }
        end
      end
      visit(child, rootWeight, rootLabel, depth + 1)
    end)
  end
end

for _, r in ipairs(roots) do visit(r.inst, r.weight, r.label, 0) end
table.sort(out, function(a, b) return a.score > b.score end)
local capped = {}
for i = 1, math.min(${lim}, #out) do capped[i] = out[i] end
return { ok = true, total = #out, returned = #capped, candidates = capped }
`;
    return this.run(clientId, source, 15000);
  }
}
