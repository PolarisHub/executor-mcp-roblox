import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-players",
  title: "List every player currently in the server (read-only)",
  description:
    'Enumerate the live roster of the running game by calling game:GetService("Players"):GetPlayers() inside the ' +
    "client and reporting one record per Player. Use this to answer 'who is in this server right now?', to find a " +
    "specific player's UserId/DisplayName for use in other tools, to see team assignments, or to spot the local " +
    "player among everyone else. This is a pure read — it does NOT mutate game state and fires no remotes.\n\n" +
    "Each player record contains, every field independently pcall-guarded so one bad property never fails the whole " +
    "scan: Name, UserId, DisplayName, Team (the Team's Name, or nil when the player is on no team), AccountAge (days), " +
    "and isLocal (true for the one player equal to Players.LocalPlayer). Requires only the base Roblox API " +
    "(game:GetService) — no special executor capabilities. Returns { ok, count, localPlayer, players } where " +
    "localPlayer is the LocalPlayer's Name (or nil), or { error } if the Players service cannot be read.",
  category: "Session & Client",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
local okSvc, Players = pcall(function() return game:GetService("Players") end)
if not okSvc or typeof(Players) ~= "Instance" then
  return { error = "Could not get the Players service: " .. tostring(Players) }
end

local localPlayer = nil
local localName = nil
do
  local okLp, lp = pcall(function() return Players.LocalPlayer end)
  if okLp and typeof(lp) == "Instance" then
    localPlayer = lp
    local okN, n = pcall(function() return lp.Name end)
    if okN then localName = n end
  end
end

local okList, list = pcall(function() return Players:GetPlayers() end)
if not okList or type(list) ~= "table" then
  return { error = "Players:GetPlayers() failed: " .. tostring(list) }
end

local players = {}
for i = 1, #list do
  local plr = list[i]
  local rec = {}

  local okName, name = pcall(function() return plr.Name end)
  rec.Name = okName and name or nil

  local okUid, uid = pcall(function() return plr.UserId end)
  rec.UserId = okUid and uid or nil

  local okDisp, disp = pcall(function() return plr.DisplayName end)
  rec.DisplayName = okDisp and disp or nil

  local okTeam, team = pcall(function() return plr.Team end)
  if okTeam and typeof(team) == "Instance" then
    local okTn, tn = pcall(function() return team.Name end)
    rec.Team = okTn and tn or nil
  else
    rec.Team = nil
  end

  local okAge, age = pcall(function() return plr.AccountAge end)
  rec.AccountAge = okAge and age or nil

  rec.isLocal = (localPlayer ~= nil and plr == localPlayer) or false

  players[i] = rec
end

return {
  ok = true,
  count = #list,
  localPlayer = localName,
  players = players,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
