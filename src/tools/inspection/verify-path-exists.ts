import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "verify-path-exists",
  title: "Verify an instance path resolves",
  description:
    "Cheaply check whether a dotted instance path currently resolves to a real Instance, without reading any properties. " +
    "Use this as a pre-flight check before click-button / type-text-box / get-instance-properties so you fail fast with a clear message instead of acting on a stale or wrong path (UI gets created/destroyed dynamically). " +
    "Returns { exists, className?, fullName? } — when exists is false, className/fullName are omitted.",
  category: "Inspection",
  input: z.object({
    path: z
      .string()
      .describe(
        "Dotted path to verify, starting at 'game' (e.g. 'game.Players.LocalPlayer.PlayerGui.Shop.BuyButton'). Resolution walks each '.'-separated segment via direct indexing then FindFirstChild.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ path, threadContext }, ctx) {
    const source = `
local path = ${q(path)}

local function resolve(p)
  local segments = {}
  for seg in string.gmatch(p, "[^%.]+") do table.insert(segments, seg) end
  if #segments == 0 then return nil end
  local first = segments[1]
  local current
  if first == "game" or first == "Game" then
    current = game
  elseif first == "workspace" or first == "Workspace" then
    current = workspace
  else
    local ok, svc = pcall(function() return game:GetService(first) end)
    if ok and svc then
      current = svc
    else
      local ok2, child = pcall(function() return game:FindFirstChild(first) end)
      if ok2 and child then current = child end
    end
  end
  if not current then return nil end
  for i = 2, #segments do
    local name = segments[i]
    local ok, nxt = pcall(function() return (current :: any)[name] end)
    if not ok or nxt == nil then
      local ok2, child = pcall(function() return current:FindFirstChild(name) end)
      if ok2 and child then nxt = child else return nil end
    end
    current = nxt
  end
  return current
end

local inst = resolve(path)
if inst == nil or typeof(inst) ~= "Instance" then
  return { exists = false, Path = path }
end

local className
local fullName
local okC, c = pcall(function() return inst.ClassName end)
if okC then className = c end
local okF, f = pcall(function() return inst:GetFullName() end)
if okF then fullName = f end

return { exists = true, Path = path, className = className, fullName = fullName }`;

    const data = await ctx.runLuau(source, {
      timeoutMs: 15000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
