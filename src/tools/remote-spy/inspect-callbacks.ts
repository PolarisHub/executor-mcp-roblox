import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "inspect-callbacks",
  title: "Inspect RemoteFunction / BindableFunction invoke callbacks",
  description:
    "Find and disassemble the invoke callbacks bound to RemoteFunctions and BindableFunctions — these are where a " +
    "game's request/response logic lives (the server-authoritative answer to a client question, or a cross-script " +
    "RPC), so they are frequently the single most valuable functions to reverse. Unlike signal events " +
    "(OnClientEvent/OnServerEvent), invoke callbacks are stored as a hidden property on the instance and are NOT " +
    "visible to getconnections; the ONLY way to retrieve them is getcallbackvalue. This tool walks a subtree " +
    "(default the whole DataModel), and for every RemoteFunction reads its OnClientInvoke and OnServerInvoke slots, " +
    "and for every BindableFunction reads its OnInvoke slot. For each slot that actually holds a function it " +
    "captures debug.info (source / line-defined / name) so you can immediately pivot to inspect-closure, " +
    "get-closure-constants, get-closure-upvalues, scan-proto-functions, or hook-function on the exact callback. " +
    "Use the source/line to locate the defining script and the name to understand intent. " +
    "Requires getcallbackvalue (returns a clean { error } if the executor lacks it). The scan is fully pcall-guarded " +
    "(locked/parented-out/dead instances never abort it), capped by maxScan, and the output is capped by limit with " +
    "a `truncated` flag. Read-only: it inspects callbacks but never invokes or modifies them. " +
    "Returns { count, scanned, truncated, root, callbacks } where each entry is " +
    "{ remote, class, slot, callback = { source, line, name, pointer, isC } }.",
  category: "Remote Spy",
  input: z.object({
    root: z
      .string()
      .describe(
        "Luau expression for the subtree root whose descendants are scanned, evaluated as `return <root>`. " +
          "Defaults to 'game' (the whole DataModel). Narrow it to cut scan time and noise, e.g. " +
          "'game.ReplicatedStorage', 'game:GetService(\"ReplicatedStorage\").Remotes', or " +
          "'game.Players.LocalPlayer.PlayerGui'.",
      )
      .optional()
      .default("game"),
    limit: z
      .number()
      .int()
      .describe(
        "Maximum number of callback entries to return (default 150). Once reached the scan stops early and " +
          "`truncated` is set true.",
      )
      .optional()
      .default(150),
    maxScan: z
      .number()
      .int()
      .describe(
        "Maximum number of descendant instances to visit while scanning (default 8000). Caps cost on huge " +
          "DataModels; if hit, `truncated` is set true. Clamped to 100..60000.",
      )
      .optional()
      .default(8000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ root, limit, maxScan, threadContext }, ctx) {
    const lim = Math.min(Math.max(Math.floor(limit), 1), 2000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 100), 60000);
    const source = `
local __gcv = getcallbackvalue or (type(debug) == "table" and (debug.getcallbackvalue or debug.getcallback)) or nil
if type(__gcv) ~= "function" then return { error = "getcallbackvalue not available" } end

local __d = (type(debug) == "table") and debug or {}
local __getinfo = (type(getinfo) == "function" and getinfo) or __d.getinfo or __d.info
local __iscclosure = iscclosure or __d.iscclosure

local function __fullName(inst)
  local ok, n = pcall(function() return inst:GetFullName() end)
  if ok and type(n) == "string" then return n end
  local ok2, n2 = pcall(function() return inst.Name end)
  if ok2 and n2 ~= nil then return tostring(n2) end
  return "<instance>"
end

local function __fnInfo(f)
  local r = { source = "", line = -1, name = "", pointer = tostring(f) }
  if type(__iscclosure) == "function" then
    local ok, isc = pcall(__iscclosure, f)
    if ok then r.isC = isc == true end
  end
  if type(__getinfo) == "function" then
    local ok, info = pcall(__getinfo, f, "nSl")
    if ok and type(info) == "table" then
      r.source = info.source or info.short_src or ""
      r.line = info.linedefined or info.currentline or -1
      r.name = info.name or ""
    else
      local oks, s = pcall(__getinfo, f, "s"); if oks and type(s) ~= "table" and s ~= nil then r.source = tostring(s) end
      local okl, l = pcall(__getinfo, f, "l"); if okl and type(l) == "number" then r.line = l end
      local okn, n = pcall(__getinfo, f, "n"); if okn and n ~= nil and type(n) ~= "table" then r.name = tostring(n) end
    end
  end
  return r
end

-- Resolve the root expression to an Instance.
local __root
do
  local f, cerr = loadstring("return " .. ${q(root)})
  if not f then return { error = "compile error in root expression: " .. tostring(cerr) } end
  local ok, val = pcall(f)
  if not ok then return { error = "error evaluating root expression: " .. tostring(val) } end
  if typeof(val) ~= "Instance" then
    return { error = "root expression did not resolve to an Instance (got " .. typeof(val) .. ")" }
  end
  __root = val
end

local descendants
do
  local ok, d = pcall(function() return __root:GetDescendants() end)
  if not ok or type(d) ~= "table" then return { error = "failed to enumerate descendants of root" } end
  descendants = d
end

-- (class, slot) pairs to probe per ClassName.
local SLOTS = {
  RemoteFunction = { "OnClientInvoke", "OnServerInvoke" },
  BindableFunction = { "OnInvoke" },
}

local callbacks = {}
local count = 0
local scanned = 0
local truncated = false

for _, inst in ipairs(descendants) do
  scanned = scanned + 1
  if scanned > ${cap} then truncated = true; break end

  local className
  do
    local okc, c = pcall(function() return inst.ClassName end)
    if okc then className = c end
  end

  local slots = className and SLOTS[className] or nil
  if slots then
    for _, slot in ipairs(slots) do
      local okcb, cb = pcall(__gcv, inst, slot)
      if okcb and type(cb) == "function" then
        count = count + 1
        callbacks[count] = {
          remote = __fullName(inst),
          class = className,
          slot = slot,
          callback = __fnInfo(cb),
        }
        if count >= ${lim} then truncated = true; break end
      end
    end
  end

  if count >= ${lim} then break end
end

return {
  count = count,
  scanned = scanned,
  truncated = truncated,
  root = __fullName(__root),
  callbacks = callbacks,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
