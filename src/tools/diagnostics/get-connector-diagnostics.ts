import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "get-connector-diagnostics",
  title: "Connector and runtime self-report",
  description:
    "Probe the live connector/runtime from inside the Roblox client and return a self-report describing the " +
    "execution environment. Every read is pcall-guarded, so an unavailable function is reported as null rather " +
    "than failing the call. Returns { threadIdentity, executor={ name, version }, hasWebSocket, gcInfoKB, " +
    "genvKeyCount, hasReg, hasRenv, capabilities={ getgc, hookfunction, getnilinstances, getactors, " +
    "getluastate, run_on_actor, clonefunction, newcclosure, cloneref, compareinstances, getcallingscript, getscriptclosure, getsenv, getfenv, mouse1click, keypress, getcallbackvalue, firesignal, getconnections } }. Use this to confirm what the connector can do before " +
    "relying on reflection/hooking tools, or to diagnose why a client is behaving unexpectedly.",
  category: "Diagnostics",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
local function safe(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end

-- Headline capability booleans: each is true only when the named global resolves
-- to a function in the thread environment (getgenv() first, then _G).
local function hasGlobal(name)
  local hosts = {}
  local function addHost(host)
    if type(host) ~= "table" then return end
    for _, current in ipairs(hosts) do if current == host then return end end
    hosts[#hosts + 1] = host
  end
  if type(getgenv) == "function" then local ok, value = pcall(getgenv); if ok then addHost(value) end end
  if type(getfenv) == "function" then local ok, value = pcall(getfenv, 0); if ok then addHost(value) end end
  addHost(_G)
  for _, host in ipairs(hosts) do
    local okIdx, val = pcall(function() return host[name] end)
    if okIdx and type(val) == "function" then return true end
  end
  return false
end

-- Thread identity (executor scheduler level).
local threadIdentity = safe(function()
  if type(getthreadidentity) == "function" then return getthreadidentity() end
  return nil
end)

-- Executor name + version (guarded; identifyexecutor returns name, version).
local executorName, executorVersion = nil, nil
if type(identifyexecutor) == "function" then
  local ok, n, v = pcall(identifyexecutor)
  if ok then
    executorName = n
    executorVersion = v
  end
end

-- WebSocket availability: a table-typed global named WebSocket.
local hasWebSocket = safe(function()
  return type(WebSocket) == "table"
end) == true

-- GC info in KB (Lua's collectgarbage("count") style number).
local gcInfoKB = safe(function()
  if type(gcinfo) == "function" then return gcinfo() end
  return nil
end)

-- Count of keys in getgenv() (guarded — getgenv may be absent).
local genvKeyCount = nil
if type(getgenv) == "function" then
  local ok, env = pcall(getgenv)
  if ok and type(env) == "table" then
    local n = 0
    local okIter = pcall(function()
      for _ in pairs(env) do n = n + 1 end
    end)
    if okIter then genvKeyCount = n end
  end
end

-- Registry / thread-environment availability flags.
local hasReg = type(getreg) == "function"
local hasRenv = type(getrenv) == "function"

local capabilities = {
  getgc = hasGlobal("getgc"),
  hookfunction = hasGlobal("hookfunction"),
  getnilinstances = hasGlobal("getnilinstances"),
  getactors = hasGlobal("getactors"),
  getluastate = hasGlobal("getluastate"),
  getactorstates = hasGlobal("getactorstates"),
  run_on_actor = hasGlobal("run_on_actor"),
  create_comm_channel = hasGlobal("create_comm_channel"),
  clonefunction = hasGlobal("clonefunction"),
  newcclosure = hasGlobal("newcclosure"),
  restorefunction = hasGlobal("restorefunction"),
  cloneref = hasGlobal("cloneref"),
  compareinstances = hasGlobal("compareinstances"),
  getcallingscript = hasGlobal("getcallingscript"),
  getscriptclosure = hasGlobal("getscriptclosure"),
  getsenv = hasGlobal("getsenv"),
  getfenv = hasGlobal("getfenv"),
  mouse1click = hasGlobal("mouse1click"),
  keypress = hasGlobal("keypress"),
  getcallbackvalue = hasGlobal("getcallbackvalue"),
  firesignal = hasGlobal("firesignal"),
  getconnections = hasGlobal("getconnections"),
}

return {
  threadIdentity = threadIdentity,
  executor = { name = executorName, version = executorVersion },
  hasWebSocket = hasWebSocket,
  gcInfoKB = gcInfoKB,
  genvKeyCount = genvKeyCount,
  hasReg = hasReg,
  hasRenv = hasRenv,
  capabilities = capabilities,
  ok = true,
}
`;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
