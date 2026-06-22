import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "get-render-stats",
  title: "Runtime perf snapshot (FPS, frame time, camera, players)",
  description:
    "In-game performance/runtime snapshot taken at the instant of the call. Reports: the physics frame rate from " +
    "workspace:GetRealPhysicsFPS(); engine timing from game:GetService('Stats') when available (FrameTime in seconds " +
    "and HeartbeatTimeMs); the current camera's world position (from its CFrame) and FieldOfView; the live player " +
    "count from #Players:GetPlayers(); and workspace.DistributedGameTime (server-synchronized clock). " +
    "Use this for a one-shot health read while debugging (is the client dropping frames? where is the camera? how many " +
    "players are present?), or to capture a baseline before/after an exploit to see its perf impact. " +
    "Every field is independently pcall-guarded and reported as null when unavailable, so the tool always returns a " +
    "partial snapshot rather than failing. Requires nothing beyond a live game. " +
    "Returns { physicsFPS, frameTimeSeconds, heartbeatTimeMs, camera: { position, fieldOfView }, playerCount, " +
    "distributedGameTime } or { error }.",
  category: "Diagnostics",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
local out = {
  physicsFPS = nil,
  frameTimeSeconds = nil,
  heartbeatTimeMs = nil,
  camera = nil,
  playerCount = nil,
  distributedGameTime = nil,
}

-- Physics FPS.
local okFPS, fps = pcall(function() return workspace:GetRealPhysicsFPS() end)
if okFPS and type(fps) == "number" then out.physicsFPS = fps end

-- Stats timing items.
local okStats, stats = pcall(function() return game:GetService("Stats") end)
if okStats and stats then
  local okFT, ft = pcall(function() return stats.FrameTime end)
  if okFT and type(ft) == "number" then out.frameTimeSeconds = ft end
  local okHB, hb = pcall(function() return stats.HeartbeatTimeMs end)
  if okHB and type(hb) == "number" then out.heartbeatTimeMs = hb end
end

-- Camera position + FOV.
local okCam, cam = pcall(function() return workspace.CurrentCamera end)
if okCam and cam then
  local camOut = {}
  local okCF, cf = pcall(function() return cam.CFrame end)
  if okCF and cf then
    local okP, p = pcall(function()
      local x, y, z = cf.Position.X, cf.Position.Y, cf.Position.Z
      return { x = x, y = y, z = z }
    end)
    if okP and p then camOut.position = p end
  end
  local okFov, fov = pcall(function() return cam.FieldOfView end)
  if okFov and type(fov) == "number" then camOut.fieldOfView = fov end
  if next(camOut) ~= nil then out.camera = camOut end
end

-- Player count.
local okPl, players = pcall(function() return game:GetService("Players") end)
if okPl and players then
  local okList, list = pcall(function() return players:GetPlayers() end)
  if okList and type(list) == "table" then out.playerCount = #list end
end

-- DistributedGameTime.
local okDGT, dgt = pcall(function() return workspace.DistributedGameTime end)
if okDGT and type(dgt) == "number" then out.distributedGameTime = dgt end

out.ok = true
return out
`;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
