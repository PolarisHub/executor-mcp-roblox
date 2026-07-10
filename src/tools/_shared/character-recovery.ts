/**
 * Reusable guidance for games whose player avatar is custom, delayed, hidden,
 * or not represented by the standard LocalPlayer.Character hierarchy.
 */
export const CHARACTER_RECOVERY_SCRIPT = `
local Players = game:GetService("Players")
local localPlayer = Players.LocalPlayer
local character = localPlayer and localPlayer.Character
local function pathOf(instance)
  local ok, value = pcall(function() return instance:GetFullName() end)
  return ok and value or tostring(instance)
end
local function first(root, names)
  if not root then return nil end
  for _, name in ipairs(names) do
    local found = root:FindFirstChild(name, true)
    if found then return found end
  end
  return nil
end
local humanoid = character and character:FindFirstChildOfClass("Humanoid")
local root = first(character, { "HumanoidRootPart", "RootPart", "LowerTorso", "Torso" })
if not root and character and character:IsA("Model") then root = character.PrimaryPart end
return {
  player = localPlayer and localPlayer.Name or nil,
  character = character and pathOf(character) or nil,
  humanoid = humanoid and pathOf(humanoid) or nil,
  humanoidRootPart = root and pathOf(root) or nil,
  customCharacter = character ~= nil and (humanoid == nil or root == nil) or false,
}
`;

export interface CharacterRecoveryNotice {
  readonly status: "missing-or-custom";
  readonly message: string;
  readonly missing: readonly string[];
  readonly nextTools: readonly string[];
  readonly recommendedScript: string;
}

export function characterRecoveryNotice(missing: readonly string[]): CharacterRecoveryNotice {
  return {
    status: "missing-or-custom",
    message:
      "The standard character hierarchy is missing or incomplete. Do not keep retrying the default path; search the live game for a custom character model, Humanoid, and root part, then use the resolved paths.",
    missing,
    nextTools: ["discover-character", "search-instances", "script"],
    recommendedScript: CHARACTER_RECOVERY_SCRIPT,
  };
}
