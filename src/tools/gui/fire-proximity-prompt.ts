import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "fire-proximity-prompt",
  title: "Trigger a ProximityPrompt",
  description:
    "WRITES LIVE GAME STATE. Resolve a Luau expression to a ProximityPrompt and trigger it via the executor's " +
    "fireproximityprompt, exactly as if the local player walked up and held the prompt's key to completion. This " +
    "bypasses distance, hold-duration, line-of-sight and Enabled checks and fires the prompt's Triggered signal, so " +
    "any server logic bound to it runs (open a door, buy an item, pick up an object). Use it to drive interaction-" +
    "gated game flow during automation/testing. Guards that fireproximityprompt exists in this executor and that the " +
    "target is actually a ProximityPrompt before firing; the fire call is pcall-guarded. WARNING: this mutates the " +
    "running game and the effect may replicate to the server. Returns { Path, ok } or { error }.",
  category: "GUI",
  mutatesState: true,
  input: z.object({
    path: z
      .string()
      .describe(
        "Luau expression resolving to the ProximityPrompt to fire, e.g. " +
          "'game.Workspace.Door.Attachment.ProximityPrompt' or " +
          "'game.Workspace.Shop.BuyPart.ProximityPrompt'. Evaluated as `return <path>` and must resolve to an " +
          "Instance whose ClassName is 'ProximityPrompt'.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ path, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(fireproximityprompt) ~= "function" then return { error = "fireproximityprompt is not available in this executor." } end

local inst, err = __eval(${q(path)})
if err then return { error = err } end
if typeof(inst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(inst) .. "): " .. ${q(path)} } end
local okIs, isPrompt = pcall(function() return inst:IsA("ProximityPrompt") end)
if not okIs or not isPrompt then return { error = "expression did not resolve to a ProximityPrompt: " .. ${q(path)} } end

local okFire, fireErr = pcall(fireproximityprompt, inst)
if not okFire then return { error = "fireproximityprompt failed: " .. tostring(fireErr) } end

local okPath, full = pcall(function() return inst:GetFullName() end)

return { Path = okPath and full or ${q(path)}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
