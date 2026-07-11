import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/** The curated probe list. Dotted names are resolved against their parent table. */
const NAMES = [
  "getgc",
  "getconstants",
  "getupvalues",
  "getprotos",
  "getinfo",
  "debug.getinfo",
  "debug.getconstants",
  "debug.getupvalues",
  "debug.getprotos",
  "getfunctionhash",
  "checkcaller",
  "clonefunction",
  "clonefunc",
  "iscclosure",
  "islclosure",
  "isexecutorclosure",
  "checkclosure",
  "isourclosure",
  "isfunctionhooked",
  "isnewcclosure",
  "iscustomcclosure",
  "newlclosure",
  "setstackhidden",
  "getconstant",
  "getupvalue",
  "getproto",
  "setconstant",
  "setupvalue",
  "setfenv",
  "getscriptbytecode",
  "getscriptclosure",
  "getcallingscript",
  "getscriptfromthread",
  "getscripthash",
  "getscripts",
  "getrunningscripts",
  "getloadedmodules",
  "getsenv",
  "getfenv",
  "getactors",
  "run_on_actor",
  "getluastate",
  "getgamestate",
  "getactorstates",
  "isparallel",
  "is_parallel",
  "create_comm_channel",
  "get_comm_channel",
  "LuaStateProxy.new",
  "getnilinstances",
  "getinstances",
  "cloneref",
  "compareinstances",
  "getgenv",
  "getrenv",
  "getreg",
  "hookfunction",
  "hookmetamethod",
  "restorefunction",
  "newcclosure",
  "getrawmetatable",
  "setrawmetatable",
  "setreadonly",
  "isreadonly",
  "getnamecallmethod",
  "getconnections",
  "firesignal",
  "replicatesignal",
  "getcallbackvalue",
  "getsignalarguments",
  "setthreadidentity",
  "getthreadidentity",
  "loadstring",
  "fireproximityprompt",
  "fireclickdetector",
  "firetouchinterest",
  "getcustomasset",
  "request",
  "http_request",
  "mouse1click",
  "mouse1press",
  "mouse1release",
  "mouse2click",
  "mouse2press",
  "mouse2release",
  "mousemoveabs",
  "mousemoverel",
  "mousescroll",
  "keypress",
  "keyrelease",
  "keyclick",
  "iswindowactive",
];

export default defineTool({
  name: "test-capabilities",
  title: "Executor capability matrix (closure, Actor/state, and core primitives)",
  description:
    "In-game capability matrix: probes a curated executor/runtime function list and reports which are " +
    "present (callable) versus missing. For each name it checks the global environment (getgenv() first, then the " +
    "thread's environment / _G) and, for dotted names like 'debug.getinfo', walks the parent table — classifying the " +
    "leaf as available only when it is type=='function'. The probe NEVER calls the functions, so it is completely safe " +
    "and side-effect-free. " +
    "Covers reflection/closures (getgc, constants/upvalues/protos, clone/wrapper/type/hook/hash functions), script " +
    "access (getscriptbytecode/closure/caller/hash, getscripts, getrunningscripts, getloadedmodules, getsenv/getfenv), instance/actor discovery " +
    "(getactors, Actor Lua-state execution, communication channels, getnilinstances, getinstances), environments (getgenv, getrenv, getreg), hooking " +
    "(hookfunction, hookmetamethod, restorefunction, newcclosure), metatables (getrawmetatable, setrawmetatable, " +
    "setreadonly, isreadonly), namecall/signals (getnamecallmethod, getconnections, firesignal, replicatesignal, " +
    "getcallbackvalue, getsignalarguments), threads (setthreadidentity, getthreadidentity), and IO/misc (loadstring, " +
    "fireproximityprompt, fireclickdetector, firetouchinterest, virtual-input globals, getcustomasset, request/http_request). " +
    "Use this to decide up-front whether a workflow is supported, or to compare two executors. " +
    "Returns { total, availableCount, missingCount, available[], missing[] } (both lists sorted) or { error }.",
  category: "Diagnostics",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const namesLuau = NAMES.map((n) => JSON.stringify(n)).join(", ");

    const source = `
local NAMES = { ${namesLuau} }

-- Build a list of candidate host tables to look a name up in.
local hosts = {}
local function __pushHost(t) if type(t) == "table" then hosts[#hosts + 1] = t end end
if type(getgenv) == "function" then local ok, g = pcall(getgenv); if ok then __pushHost(g) end end
if type(getfenv) == "function" then local ok, f = pcall(getfenv, 0); if ok then __pushHost(f) end end
if type(getrenv) == "function" then local ok, r = pcall(getrenv); if ok then __pushHost(r) end end
__pushHost(_G)

-- Resolve a possibly-dotted name to a value across all hosts; returns the value or nil.
local function __resolve(name)
  -- Split on '.'
  local parts = {}
  for p in string.gmatch(name, "[^%.]+") do parts[#parts + 1] = p end
  for _, host in ipairs(hosts) do
    local cur = host
    local okWalk = true
    for i = 1, #parts do
      if type(cur) ~= "table" then okWalk = false; break end
      local nxt = nil
      local okIdx = pcall(function() nxt = cur[parts[i]] end)
      if not okIdx then okWalk = false; break end
      cur = nxt
    end
    if okWalk and type(cur) == "function" then return cur end
  end
  return nil
end

local available = {}
local missing = {}
for _, name in ipairs(NAMES) do
  local fn = __resolve(name)
  if type(fn) == "function" then
    available[#available + 1] = name
  else
    missing[#missing + 1] = name
  end
end

table.sort(available)
table.sort(missing)

return {
  total = #NAMES,
  availableCount = #available,
  missingCount = #missing,
  available = available,
  missing = missing,
  ok = true,
}
`;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
