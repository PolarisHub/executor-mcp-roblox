import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "get-game-info",
  title: "Get current Roblox place and universe metadata",
  description:
    "Read identifying metadata for the game the active client is in: PlaceId, GameId (universe), JobId (server " +
    "instance), PlaceVersion, the place/universe name where readable, and the current player count. Every read is " +
    "pcall-guarded, so a restricted field is reported as null rather than failing the call. Use this to confirm " +
    "which game/server you are attached to before running place-specific code.",
  category: "Diagnostics",
  input: z.object({}),
  async execute(_input, ctx) {
    const source = `
local function safe(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end

return {
  placeId = safe(function() return game.PlaceId end),
  gameId = safe(function() return game.GameId end),
  jobId = safe(function() return game.JobId end),
  placeVersion = safe(function() return game.PlaceVersion end),
  name = safe(function() return game.Name end),
  creatorId = safe(function() return game.CreatorId end),
  playerCount = safe(function() return #game:GetService("Players"):GetPlayers() end),
  maxPlayers = safe(function() return game:GetService("Players").MaxPlayers end),
  ok = true,
}
`;
    const result = (await ctx.runLuau(source)) as {
      placeId?: number | null;
      name?: string | null;
      playerCount?: number | null;
    };
    return {
      data: result,
      summary:
        `Place ${result?.placeId ?? "?"}` +
        `${result?.name ? ` (${result.name})` : ""}, ${result?.playerCount ?? "?"} player(s).`,
    };
  },
});
