import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "fire-click-detector",
  title: "Trigger a ClickDetector",
  description:
    "WRITES LIVE GAME STATE. Resolve a Luau expression to a ClickDetector and trigger it via the executor's " +
    "fireclickdetector, exactly as if the local player clicked the part it is attached to. This bypasses " +
    "MaxActivationDistance and line-of-sight and fires the MouseClick signal, so any server/client logic bound to " +
    "the detector runs (buy buttons, levers, clickable doors, NPC dialogs). Use it to drive click-gated game flow " +
    "during automation/testing. Guards that fireclickdetector exists in this executor and that the target is " +
    "actually a ClickDetector before firing; the fire call is pcall-guarded. WARNING: this mutates the running game " +
    "and the effect may replicate to the server. Returns { Path, ok } or { error }.",
  category: "GUI",
  mutatesState: true,
  input: z.object({
    path: z
      .string()
      .describe(
        "Luau expression resolving to the ClickDetector to fire, e.g. " +
          "'game.Workspace.Lever.ClickDetector' or 'game.Workspace.Shop.BuyButton.ClickDetector'. Evaluated as " +
          "`return <path>` and must resolve to an Instance whose ClassName is 'ClickDetector'.",
      ),
    distance: z
      .number()
      .describe(
        "The distance (studs) to report to the detector as the click origin, passed as the second argument to " +
          "fireclickdetector(cd, distance). Default 0 (treated as point-blank). Some games read this value to gate " +
          "behavior; leave at 0 unless you need to emulate a specific click distance.",
      )
      .optional()
      .default(0),
    threadContext: z.number().int().optional(),
  }),
  async execute({ path, distance, threadContext }, ctx) {
    const dist = Number.isFinite(distance) ? distance : 0;
    const source = `
${REFLECT_PRELUDE}
if type(fireclickdetector) ~= "function" then return { error = "fireclickdetector is not available in this executor." } end

local inst, err = __eval(${q(path)})
if err then return { error = err } end
if typeof(inst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(inst) .. "): " .. ${q(path)} } end
local okIs, isCd = pcall(function() return inst:IsA("ClickDetector") end)
if not okIs or not isCd then return { error = "expression did not resolve to a ClickDetector: " .. ${q(path)} } end

local okFire, fireErr = pcall(fireclickdetector, inst, ${dist})
if not okFire then return { error = "fireclickdetector failed: " .. tostring(fireErr) } end

local okPath, full = pcall(function() return inst:GetFullName() end)

return { Path = okPath and full or ${q(path)}, ok = true }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
