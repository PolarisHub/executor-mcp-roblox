import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-remote-signature",
  title: "Probe a single remote/bindable's shape (arg types, listeners, callback)",
  description:
    "Read-only inspection of ONE remote or bindable to learn how it is used WITHOUT firing it or installing any hook. " +
    "Resolves `remotePath` to an Instance, reports its ClassName, then probes class-appropriately:\n" +
    "  - RemoteEvent / UnreliableRemoteEvent: reads getsignalarguments(remote.OnClientEvent) to surface the recent " +
    "argument types the server sent to the client, and getconnections(remote.OnClientEvent) to count how many local " +
    "listeners are attached (both guarded).\n" +
    "  - RemoteFunction: reads getcallbackvalue(remote, 'OnClientInvoke') and, if it is a function, reports its " +
    "debug.info (source/line/name/params) so you can locate the handler the client registered.\n" +
    "  - BindableEvent: same OnClientEvent-style getsignalarguments + getconnections probe but on .Event.\n" +
    "  - BindableFunction: getcallbackvalue(remote, 'OnInvoke') -> function info.\n" +
    "Use this after list-remotes to understand a specific remote before firing it (fire-remote) or before spying it " +
    "(monitor-remote). It tells you the argument shape and whether anything is listening, which is exactly what you " +
    "need to craft a valid call. Each probe is optional and pcall-guarded: a field is omitted (with a *Error note) " +
    "when the executor lacks the capability or the read fails — the tool never throws. Requires (optionally) " +
    "getsignalarguments, getconnections, getcallbackvalue, and debug.info; missing ones simply skip that field. " +
    "Returns { ok, path, class, signalArguments?, connectionCount?, callback?, notes }, or { error }.",
  category: "Remote Spy",
  input: z.object({
    remotePath: z
      .string()
      .describe(
        "Luau expression resolving to the RemoteEvent / RemoteFunction / UnreliableRemoteEvent / BindableEvent / " +
          "BindableFunction to inspect, e.g. " +
          "'game:GetService(\"ReplicatedStorage\").Remotes.BuyItem' or " +
          "'game.ReplicatedStorage:WaitForChild(\"DataRemote\")'. Evaluated as `return <remotePath>` and must resolve " +
          "to an Instance of one of those classes.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ remotePath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
local remote, err = __eval(${q(remotePath)})
if err then return { error = err } end
if typeof(remote) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(remote) .. "): " .. ${q(remotePath)} } end

local okClass, cls = pcall(function() return remote.ClassName end)
if not okClass then return { error = "failed to read ClassName: " .. tostring(cls) } end

local KNOWN = {
  RemoteEvent = true, RemoteFunction = true, UnreliableRemoteEvent = true,
  BindableEvent = true, BindableFunction = true,
}

local path
local okName, full = pcall(function() return remote:GetFullName() end)
if okName then path = full else path = ${q(remotePath)} end

local __getsignalarguments = getsignalarguments
local __getconnections = getconnections
local __getcallbackvalue = getcallbackvalue

local result = { ok = true, path = path, class = cls, notes = {} }
local notes = result.notes

if not KNOWN[cls] then
  notes[#notes + 1] = "ClassName '" .. tostring(cls) .. "' is not a known remote/bindable class; probing skipped."
  return result
end

-- Probe the signal that carries inbound traffic for this class.
-- RemoteEvent/Unreliable -> OnClientEvent ; BindableEvent -> Event ; (RemoteFunction/BindableFunction use a callback).
local function probeSignal(signalName)
  local okSig, signal = pcall(function() return remote[signalName] end)
  if not okSig or signal == nil then
    notes[#notes + 1] = "could not read signal '" .. signalName .. "': " .. tostring(signal)
    return
  end

  if type(__getsignalarguments) == "function" then
    local okA, args = pcall(__getsignalarguments, signal)
    if okA and type(args) == "table" then
      -- getsignalarguments may return a list of fire-records (each a table of the
      -- real args) OR a flat arg list. Encode one level deep so a fire-record
      -- yields its per-argument types instead of just {"table","table",...}.
      local enc = {}
      for i = 1, #args do
        local a = args[i]
        if type(a) == "table" then
          local inner = {}
          for k, v in pairs(a) do
            local okT, t = pcall(typeof, v)
            if okT then inner[k] = t else inner[k] = __encVal(v) end
          end
          enc[i] = inner
        else
          local okT, t = pcall(typeof, a)
          if okT then enc[i] = t else enc[i] = __encVal(a) end
        end
      end
      result.signalArguments = enc
      result.signalArgumentsFrom = signalName
    else
      notes[#notes + 1] = "getsignalarguments(" .. signalName .. ") failed or returned no recent args."
    end
  else
    notes[#notes + 1] = "getsignalarguments is not available in this executor."
  end

  if type(__getconnections) == "function" then
    local okC, conns = pcall(__getconnections, signal)
    if okC and type(conns) == "table" then
      result.connectionCount = #conns
    else
      notes[#notes + 1] = "getconnections(" .. signalName .. ") failed."
    end
  else
    notes[#notes + 1] = "getconnections is not available in this executor."
  end
end

-- Probe a callback property (RemoteFunction.OnClientInvoke / BindableFunction.OnInvoke).
local function probeCallback(propName)
  if type(__getcallbackvalue) ~= "function" then
    notes[#notes + 1] = "getcallbackvalue is not available in this executor; cannot read " .. propName .. "."
    return
  end
  local okCb, cb = pcall(__getcallbackvalue, remote, propName)
  if not okCb then
    notes[#notes + 1] = "getcallbackvalue(" .. propName .. ") failed: " .. tostring(cb)
    return
  end
  if type(cb) ~= "function" then
    result.callback = { property = propName, present = false }
    notes[#notes + 1] = propName .. " is not set (no callback registered on this client)."
    return
  end
  local info = __fnInfo(cb)
  result.callback = { property = propName, present = true, info = info }
end

if cls == "RemoteEvent" or cls == "UnreliableRemoteEvent" then
  probeSignal("OnClientEvent")
elseif cls == "BindableEvent" then
  probeSignal("Event")
elseif cls == "RemoteFunction" then
  probeCallback("OnClientInvoke")
elseif cls == "BindableFunction" then
  probeCallback("OnInvoke")
end

return result
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
