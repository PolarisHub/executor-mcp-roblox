import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { characterRecoveryNotice } from "../_shared/character-recovery.js";
import { REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-local-player-info",
  title: "Rich snapshot of the local player, character, and humanoid (read-only)",
  description:
    "Capture a single, comprehensive read-only snapshot of THIS client's own player (Players.LocalPlayer), the " +
    "character model it currently controls, and that character's Humanoid. Use this as the first call when debugging " +
    "anything about 'me' — health/death state, movement (WalkSpeed/JumpPower), spawn position, rig type, or simply to " +
    "confirm the LocalPlayer's Name/UserId/Team before targeting other tools. It is a pure read: it mutates nothing " +
    "and fires no remotes.\n\n" +
    "Every field is independently pcall-guarded and reported as nil when absent (e.g. while dead/respawning the " +
    "character or humanoid may be missing), so a partial state never errors the whole call. Returns " +
    "{ ok, player, character } where:\n" +
    "  player  = { Name, UserId, DisplayName, AccountAge, Team } (Team is the Team's Name or nil).\n" +
    "  character = { Name, Health, MaxHealth, WalkSpeed, JumpPower, JumpHeight, MoveMagnitude (magnitude of " +
    "Humanoid.MoveDirection), RigType (tostring of Humanoid.RigType), Position ({x,y,z} of the HumanoidRootPart) } — " +
    "any of which may be nil. Requires only the base Roblox API; no special executor capabilities. Returns { error } " +
    "only if the Players service itself cannot be read.",
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

local okLp, lp = pcall(function() return Players.LocalPlayer end)
if not okLp or typeof(lp) ~= "Instance" then
  return { error = "Players.LocalPlayer is not available (got " .. tostring(lp) .. ")." }
end

local player = {}
do
  local okName, name = pcall(function() return lp.Name end); player.Name = okName and name or nil
  local okUid, uid = pcall(function() return lp.UserId end); player.UserId = okUid and uid or nil
  local okDisp, disp = pcall(function() return lp.DisplayName end); player.DisplayName = okDisp and disp or nil
  local okAge, age = pcall(function() return lp.AccountAge end); player.AccountAge = okAge and age or nil
  local okTeam, team = pcall(function() return lp.Team end)
  if okTeam and typeof(team) == "Instance" then
    local okTn, tn = pcall(function() return team.Name end)
    player.Team = okTn and tn or nil
  else
    player.Team = nil
  end
end

local character = nil
do
  local okChar, char = pcall(function() return lp.Character end)
  if okChar and typeof(char) == "Instance" then
    character = {}
    local okCn, cn = pcall(function() return char.Name end); character.Name = okCn and cn or nil

    local okHum, hum = pcall(function() return char:FindFirstChildOfClass("Humanoid") end)
    if okHum and typeof(hum) == "Instance" then
      local okH, h = pcall(function() return hum.Health end); character.Health = okH and h or nil
      local okMh, mh = pcall(function() return hum.MaxHealth end); character.MaxHealth = okMh and mh or nil
      local okWs, ws = pcall(function() return hum.WalkSpeed end); character.WalkSpeed = okWs and ws or nil
      local okJp, jp = pcall(function() return hum.JumpPower end); character.JumpPower = okJp and jp or nil
      local okJh, jh = pcall(function() return hum.JumpHeight end); character.JumpHeight = okJh and jh or nil
      local okMd, md = pcall(function() return hum.MoveDirection.Magnitude end); character.MoveMagnitude = okMd and md or nil
      local okRt, rt = pcall(function() return tostring(hum.RigType) end); character.RigType = okRt and rt or nil
    end

    local okRoot, root = pcall(function() return char:FindFirstChild("HumanoidRootPart") end)
    if okRoot and typeof(root) == "Instance" then
      local okPos, pos = pcall(function() return root.Position end)
      if okPos and typeof(pos) == "Vector3" then
        character.Position = { x = pos.X, y = pos.Y, z = pos.Z }
      end
    end
  end
end

if character == nil or character.Health == nil or character.Position == nil then
  pcall(function()
    warn("[executor-mcp-roblox] Standard character path is missing or incomplete; custom character discovery is required.")
  end)
end

return {
  ok = true,
  player = player,
  character = character,
}
`;
    const data = (await ctx.runLuau(source, { threadContext, timeoutMs: 20000 })) as Record<
      string,
      unknown
    > | null;
    const character = data?.["character"];
    const characterRecord =
      character && typeof character === "object" && !Array.isArray(character)
        ? (character as Record<string, unknown>)
        : null;
    const missing: string[] = [];
    if (character === null || character === undefined) missing.push("character");
    if (characterRecord?.["Health"] === undefined) missing.push("Humanoid");
    if (characterRecord?.["Position"] === undefined) {
      missing.push("HumanoidRootPart");
    }
    if (data?.["ok"] === true && missing.length > 0) {
      data["characterRecovery"] = characterRecoveryNotice(missing);
      return {
        data,
        summary:
          "Character data is missing (" +
          missing.join(", ") +
          "). Run discover-character or search the live game with a custom script; do not retry the standard path blindly.",
      };
    }
    return { data };
  },
});
