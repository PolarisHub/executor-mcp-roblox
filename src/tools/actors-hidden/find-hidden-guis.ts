import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { HIDDEN_PRELUDE } from "../_shared/hidden.js";

export default defineTool({
  name: "find-hidden-guis",
  title: "Find hidden GUI containers",
  description:
    "Surface GUI overlays/menus that are hidden away from the normal PlayerGui hierarchy — the classic home of cheat " +
    "menus, ESP overlays, and anti-detection UIs. Scans every nil-parented instance (getnilinstances) and the children " +
    "of CoreGui, keeping anything that is a GUI container (LayerCollector / ScreenGui / BillboardGui / SurfaceGui / any " +
    "GuiBase2d). Each hit reports its name, class, full path, and where it is hidden (location: nil-parented, CoreGui, " +
    "detached, inside an Actor, etc.). Results are deduped. Requires getnilinstances for the " +
    "nil sweep; the CoreGui sweep still runs even if getnilinstances is missing.",
  category: "Actors & Hidden",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
${HIDDEN_PRELUDE}
local GUI_CLASSES = { "LayerCollector", "ScreenGui", "BillboardGui", "SurfaceGui", "GuiBase2d" }
local function __isGui(inst)
  for _, cls in GUI_CLASSES do
    if __isA(inst, cls) then return true end
  end
  return false
end

local guis = {}
local seen = {}
local truncated = false
local CAP = 200

local function consider(inst)
  if inst == nil or seen[inst] then return end
  seen[inst] = true
  if not __isGui(inst) then return end
  if #guis >= CAP then
    truncated = true
    return
  end
  guis[#guis + 1] = {
    name = __name(inst),
    class = __class(inst),
    location = __location(inst),
    fullName = __fullName(inst),
  }
end

-- 1) Nil-parented instances (guarded; may be unavailable).
if type(getnilinstances) == "function" then
  local okN, nils = pcall(getnilinstances)
  if okN and type(nils) == "table" then
    for _, inst in nils do consider(inst) end
  end
end

-- 2) Children of CoreGui (always attempted; pcall-guarded).
local okCore, cg = pcall(function() return game:GetService("CoreGui") end)
if okCore and cg then
  local okKids, kids = pcall(function() return cg:GetDescendants() end)
  if okKids and type(kids) == "table" then
    for _, inst in kids do consider(inst) end
  end
end

return { count = #guis, truncated = truncated, guis = guis }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    return { data };
  },
});
