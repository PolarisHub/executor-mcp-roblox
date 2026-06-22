import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "get-anticheat-surfaces",
  title: "Lightweight anti-cheat surface summary",
  description:
    "Fast, lightweight defensive recon that summarizes the most common anti-cheat surfaces WITHOUT a heavy GC walk " +
    "(complements, and does not duplicate, the deeper scan-hook-surfaces tool). It checks: (1) how many connections are " +
    "attached to RunService's Heartbeat, Stepped, and RenderStepped — the signals anti-cheats most often use for " +
    "per-frame validation loops — via getconnections; (2) whether game's raw metatable is locked (isreadonly on " +
    "getrawmetatable(game)), which gates __index/__namecall hooking; (3) the count of nil-parented instances " +
    "(getnilinstances), where detached watchdog scripts/objects often hide; and (4) any getgenv() global names that " +
    "look anti-cheat-related (matching detect/ban/kick/anticheat/flag/cheat, case-insensitive), which can reveal an " +
    "exploit's own loader or a leaked server-side guard name. " +
    "Use this as a quick 'how watched am I?' read before installing hooks. Each probe degrades gracefully and is " +
    "pcall-guarded; missing executor functions are reported as unavailable rather than failing the call. " +
    "Returns { runServiceConnections, gameMetatableReadonly, nilInstanceCount, suspiciousGlobals, notes } or { error }.",
  category: "Diagnostics",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
local out = {
  runServiceConnections = nil,
  gameMetatableReadonly = nil,
  nilInstanceCount = nil,
  suspiciousGlobals = {},
  notes = {},
}

-- (1) Connection counts on the hot RunService signals.
if type(getconnections) ~= "function" then
  out.notes[#out.notes + 1] = "getconnections unavailable; cannot count RunService connections."
else
  local okR, rs = pcall(function() return game:GetService("RunService") end)
  if okR and rs then
    local rsc = {}
    local signals = { "Heartbeat", "Stepped", "RenderStepped" }
    for _, sig in ipairs(signals) do
      local okS, signal = pcall(function() return rs[sig] end)
      if okS and signal then
        local okC, conns = pcall(getconnections, signal)
        if okC and type(conns) == "table" then
          rsc[sig] = #conns
        else
          rsc[sig] = "unavailable"
        end
      else
        rsc[sig] = "no-signal"
      end
    end
    out.runServiceConnections = rsc
  else
    out.notes[#out.notes + 1] = "Could not resolve RunService."
  end
end

-- (2) Is game's raw metatable locked?
if type(getrawmetatable) ~= "function" then
  out.notes[#out.notes + 1] = "getrawmetatable unavailable; cannot inspect game metatable lock."
else
  local okM, mt = pcall(getrawmetatable, game)
  if okM and type(mt) == "table" then
    if type(isreadonly) == "function" then
      local okRO, ro = pcall(isreadonly, mt)
      if okRO then out.gameMetatableReadonly = (ro == true) end
    else
      out.notes[#out.notes + 1] = "isreadonly unavailable; metatable lock state unknown."
    end
  else
    out.notes[#out.notes + 1] = "getrawmetatable(game) returned no table."
  end
end

-- (3) Nil-parented instance count.
if type(getnilinstances) == "function" then
  local okN, nils = pcall(getnilinstances)
  if okN and type(nils) == "table" then out.nilInstanceCount = #nils end
else
  out.notes[#out.notes + 1] = "getnilinstances unavailable; cannot count nil instances."
end

-- (4) Suspicious global names in getgenv().
if type(getgenv) == "function" then
  local okG, genv = pcall(getgenv)
  if okG and type(genv) == "table" then
    local patterns = { "detect", "ban", "kick", "anticheat", "anti%-cheat", "flag", "cheat", "exploit" }
    local seen = {}
    local cap = 30
    local count = 0
    -- A proxy/locked env can throw inside pairs() (e.g. a hostile __iter), so the
    -- whole enumeration is pcall-isolated; probes 1-3 still return on failure.
    local okEnum = pcall(function()
      for k, _ in pairs(genv) do
        if type(k) == "string" then
          local lk = string.lower(k)
          for _, p in ipairs(patterns) do
            if string.find(lk, p) then
              if not seen[k] then
                seen[k] = true
                out.suspiciousGlobals[#out.suspiciousGlobals + 1] = k
                count = count + 1
              end
              break
            end
          end
        end
        if count >= cap then break end
      end
    end)
    if not okEnum then out.notes[#out.notes + 1] = "could not enumerate getgenv()." end
    table.sort(out.suspiciousGlobals)
  end
else
  out.notes[#out.notes + 1] = "getgenv unavailable; cannot scan globals."
end

out.ok = true
return out
`;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
