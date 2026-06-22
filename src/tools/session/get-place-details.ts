import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-place-details",
  title: "Snapshot of the current place, server, and workspace (read-only)",
  description:
    "Read identifying and runtime details about the place and server this client is connected to. Use this to capture " +
    "the exact place/universe/server you are testing in (so a finding can be reproduced), to grab the PlaceId/GameId/" +
    "JobId for cross-referencing, to check the player count against MaxPlayers, or to confirm whether StreamingEnabled " +
    "is on (which affects whether parts may be unloaded). It is a pure read: it mutates nothing and fires no remotes.\n\n" +
    "Every field is independently pcall-guarded and reported as nil when unavailable, so a single unreadable property " +
    "never fails the whole call. Returns { ok, ... } with: PlaceId, GameId, JobId, PlaceVersion, CreatorId, " +
    "CreatorType (tostring of game.CreatorType), MaxPlayers (Players.MaxPlayers), PlayerCount (#Players:GetPlayers()), " +
    "DistributedGameTime (workspace.DistributedGameTime, the server clock in seconds), and StreamingEnabled " +
    "(workspace.StreamingEnabled). Requires only the base Roblox API; no special executor capabilities. Returns " +
    "{ error } only if the game/DataModel itself cannot be accessed.",
  category: "Session & Client",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if typeof(game) ~= "Instance" then
  return { error = "The game DataModel is not accessible in this context." }
end

local okSvc, Players = pcall(function() return game:GetService("Players") end)
local okWs, ws = pcall(function() return workspace end)
if not (okWs and typeof(ws) == "Instance") then
  local okWs2, ws2 = pcall(function() return game:GetService("Workspace") end)
  if okWs2 then ws = ws2 else ws = nil end
end

local out = { ok = true }

local okPid, pid = pcall(function() return game.PlaceId end); out.PlaceId = okPid and pid or nil
local okGid, gid = pcall(function() return game.GameId end); out.GameId = okGid and gid or nil
local okJid, jid = pcall(function() return game.JobId end); out.JobId = okJid and jid or nil
local okVer, ver = pcall(function() return game.PlaceVersion end); out.PlaceVersion = okVer and ver or nil
local okCid, cid = pcall(function() return game.CreatorId end); out.CreatorId = okCid and cid or nil
local okCt, ct = pcall(function() return tostring(game.CreatorType) end); out.CreatorType = okCt and ct or nil

if okSvc and typeof(Players) == "Instance" then
  local okMax, mx = pcall(function() return Players.MaxPlayers end); out.MaxPlayers = okMax and mx or nil
  local okList, list = pcall(function() return Players:GetPlayers() end)
  if okList and type(list) == "table" then out.PlayerCount = #list else out.PlayerCount = nil end
else
  out.MaxPlayers = nil
  out.PlayerCount = nil
end

if typeof(ws) == "Instance" then
  local okDgt, dgt = pcall(function() return ws.DistributedGameTime end); out.DistributedGameTime = okDgt and dgt or nil
  -- StreamingEnabled is a boolean: a successful read of false must survive (the
  -- "ok and v or nil" idiom would collapse false -> nil, hiding streaming-off).
  local okStr, str = pcall(function() return ws.StreamingEnabled end)
  if okStr then out.StreamingEnabled = str else out.StreamingEnabled = nil end
else
  out.DistributedGameTime = nil
  out.StreamingEnabled = nil
end

return out
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
