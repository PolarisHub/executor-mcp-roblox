/**
 * Shared helpers for the "Actors & Hidden" toolkit — tools that surface things
 * which try to hide: scripts running inside Actors (parallel Luau VMs), instances
 * parented to nil, scripts detached from the game tree, hidden GUIs, etc.
 *
 * Every tool builds a Luau snippet (run via ctx.runLuau) and prepends
 * HIDDEN_PRELUDE. All helpers are fully pcall-guarded so a single weird instance
 * never aborts a whole-game scan. The canonical {@link q} (JSON-quote a string
 * into a Luau-legal literal) lives in ./luau.js and is re-exported here for
 * convenience, so consumers of this prelude have a single import.
 */

import { q } from "./luau.js";

export { q };

export const HIDDEN_PRELUDE = `
local __H = game:GetService("HttpService")

local function __name(inst)
  local ok, n = pcall(function() return inst.Name end)
  return ok and tostring(n) or "?"
end
local function __class(inst)
  local ok, c = pcall(function() return inst.ClassName end)
  return ok and c or "?"
end
local function __parent(inst)
  local ok, p = pcall(function() return inst.Parent end)
  if ok then return p end
  return nil
end
local function __fullName(inst)
  local ok, n = pcall(function() return inst:GetFullName() end)
  if ok then return n end
  return "<" .. __class(inst) .. " " .. __name(inst) .. ">"
end
-- Reachable from the DataModel (game)? If not, it is detached / hidden.
local function __inTree(inst)
  local cur = inst
  for _ = 1, 128 do
    if cur == game then return true end
    local p = __parent(cur)
    if p == nil then return false end
    cur = p
  end
  return false
end
local function __isA(inst, cls)
  local ok, r = pcall(function() return inst:IsA(cls) end)
  return ok and r
end
local function __ancestorActor(inst)
  local ok, a = pcall(function() return inst:FindFirstAncestorOfClass("Actor") end)
  if ok and a then return a end
  return nil
end
-- Where does this instance "live"? Used to explain how something is hidden.
local function __location(inst)
  local par = __parent(inst)
  if par == nil then return "nil-parented" end
  if not __inTree(inst) then return "detached (not under game)" end
  local actor = __ancestorActor(inst)
  if actor then return "inside Actor: " .. __fullName(actor) end
  local okCore, cg = pcall(function() return game:GetService("CoreGui") end)
  if okCore and cg and __isA(inst, "Instance") then
    local cur = inst
    for _ = 1, 64 do if cur == cg then return "CoreGui" end; cur = __parent(cur); if cur == nil then break end end
  end
  return "in tree"
end
`;
