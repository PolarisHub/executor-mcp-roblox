import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "get-custom-asset",
  title: "Get an rbxasset:// URL for a workspace file (UNC getcustomasset)",
  description:
    "Turn a file in the executor's workspace into a content URL (rbxasset://...) usable as an asset id for images, " +
    "sounds, meshes, etc. inside the game. NOTE: this is executor-side file I/O — the connector runs INSIDE the " +
    "executor, so the path is relative to the executor's workspace directory on the host machine, NOT the Roblox " +
    "game. This is marked state-mutating because on most executors getcustomasset COPIES the file into the Roblox " +
    "content cache as a side effect. " +
    "Requires a Volt-class executor exposing the UNC function getcustomasset(path) -> string. The call is " +
    "type-guarded and pcall-wrapped: if getcustomasset is missing you get " +
    "{ error = 'getcustomasset is not available in this executor.' }, and any failure returns { error = <message> }. " +
    "Returns { path, asset } or { error }.",
  category: "Filesystem",
  mutatesState: true,
  input: z.object({
    path: z
      .string()
      .describe(
        "Path to the file within the executor workspace to expose as an asset, e.g. 'images/logo.png'.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ path, threadContext, timeoutMs }, ctx) {
    const source = `
if type(getcustomasset) ~= "function" then
  return { error = "getcustomasset is not available in this executor." }
end
local ok, asset = pcall(getcustomasset, ${q(path)})
if not ok then return { error = tostring(asset) } end
return { path = ${q(path)}, asset = tostring(asset) }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
