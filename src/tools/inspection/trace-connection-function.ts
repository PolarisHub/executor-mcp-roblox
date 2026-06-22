import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "trace-connection-function",
  title: "Trace connection function",
  description:
    "Inspect a single connection on an Instance's RBXScriptSignal and return debug metadata about the connected Luau function. " +
    "Uses getconnections(inst[signalName]) to enumerate connections and debug.info/debug.getinfo to resolve the function's name, " +
    "source, line and parameter count. REQUIRES an executor exposing getconnections and debug.info (or debug.getinfo); " +
    "if either capability is missing, or the signal/connection/function cannot be resolved, returns a clear { error } describing " +
    "the missing capability. Returns { Signal, ConnectionIndex, ConnectionCount, Function: { Name, Source, ShortSource, LineDefined, NumParams, IsVararg, What, Pointer } }.",
  category: "Inspection",
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Lua expression resolving to the target Instance, e.g. 'game.Players.LocalPlayer.Character.Humanoid'. Evaluated as `return <instancePath>`.",
      ),
    signalName: z
      .string()
      .describe(
        "Name of the RBXScriptSignal member on the instance to inspect, e.g. 'Touched', 'Changed', 'OnClientEvent'.",
      ),
    connectionIndex: z
      .number()
      .int()
      .describe(
        "Zero-based index of the connection to trace within getconnections() results (default: 0 = first connection).",
      )
      .optional()
      .default(0),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, signalName, connectionIndex, threadContext }, ctx) {
    const safeIndex = Math.max(0, Math.floor(connectionIndex));
    const source = `
local getconnectionsFn = getconnections
if type(getconnectionsFn) ~= "function" then
  return { error = "getconnections is not available in this executor; cannot enumerate signal connections." }
end

local hasDebug = type(debug) == "table"
local debugInfoFn = hasDebug and (debug.info or debug.getinfo) or nil
if type(debugInfoFn) ~= "function" then
  return { error = "debug.info / debug.getinfo is not available in this executor; cannot inspect the connected function." }
end

local okInst, inst = pcall(function() return (loadstring("return " .. ${q(instancePath)}))() end)
if not okInst or typeof(inst) ~= "Instance" then
  return { error = "instancePath did not resolve to an Instance: " .. tostring(${q(instancePath)}) }
end

local okSig, signal = pcall(function() return inst[${q(signalName)}] end)
if not okSig then
  return { error = "Failed to access member '" .. ${q(signalName)} .. "' on " .. inst:GetFullName() .. ": " .. tostring(signal) }
end
if typeof(signal) ~= "RBXScriptSignal" then
  return { error = "Member '" .. ${q(signalName)} .. "' on " .. inst:GetFullName() .. " is not an RBXScriptSignal (got " .. typeof(signal) .. ")." }
end

local okConns, conns = pcall(getconnectionsFn, signal)
if not okConns or type(conns) ~= "table" then
  return { error = "getconnections failed for signal '" .. ${q(signalName)} .. "': " .. tostring(conns) }
end

local connectionCount = #conns
if connectionCount == 0 then
  return { error = "Signal '" .. ${q(signalName)} .. "' has no connections.", ConnectionCount = 0 }
end

local idx = ${safeIndex} + 1 -- Lua arrays are 1-based; input is 0-based.
if idx < 1 or idx > connectionCount then
  return { error = "connectionIndex out of range (have " .. connectionCount .. " connections).", ConnectionCount = connectionCount }
end

local conn = conns[idx]
local okFn, fn = pcall(function() return conn.Function end)
if not okFn or type(fn) ~= "function" then
  return {
    error = "Connection at index " .. ${safeIndex} .. " has no inspectable .Function (it may be a foreign/C connection). Got: " .. tostring(okFn and typeof(fn) or fn),
    ConnectionCount = connectionCount,
    ConnectionIndex = ${safeIndex},
  }
end

-- debug.info supports both the (fn, "options") string form and individual fields.
-- Try the rich getinfo-style call first, then fall back to field-by-field debug.info.
local function describeFunction(f)
  local result = {
    Name = "<anonymous>",
    Source = "",
    ShortSource = "",
    LineDefined = -1,
    NumParams = -1,
    IsVararg = false,
    What = "?",
    Pointer = tostring(f),
  }

  local okTbl, infoTbl = pcall(debugInfoFn, f, "nSlu")
  if okTbl and type(infoTbl) == "table" then
    result.Name = infoTbl.name or result.Name
    result.Source = infoTbl.source or result.Source
    result.ShortSource = infoTbl.short_src or result.ShortSource
    result.LineDefined = infoTbl.linedefined or result.LineDefined
    result.NumParams = infoTbl.nparams or result.NumParams
    result.IsVararg = infoTbl.isvararg == true
    result.What = infoTbl.what or result.What
    return result
  end

  -- Fall back to debug.info(f, "s") style returning multiple scalar values per option char.
  local okName, nameVal = pcall(debugInfoFn, f, "n")
  if okName and nameVal ~= nil and type(nameVal) ~= "table" then result.Name = tostring(nameVal) end
  local okSrc, srcVal = pcall(debugInfoFn, f, "s")
  if okSrc and srcVal ~= nil and type(srcVal) ~= "table" then result.Source = tostring(srcVal) end
  local okLine, lineVal = pcall(debugInfoFn, f, "l")
  if okLine and type(lineVal) == "number" then result.LineDefined = lineVal end
  local okParams, paramVal = pcall(debugInfoFn, f, "a")
  if okParams and type(paramVal) == "number" then result.NumParams = paramVal end
  return result
end

local okDesc, fnInfo = pcall(describeFunction, fn)
if not okDesc then
  return { error = "Failed to read debug info for the connected function: " .. tostring(fnInfo), ConnectionCount = connectionCount }
end

return {
  Signal = ${q(signalName)},
  Instance = inst:GetFullName(),
  ConnectionIndex = ${safeIndex},
  ConnectionCount = connectionCount,
  Function = fnInfo,
}
`;

    const data = await ctx.runLuau(source, {
      timeoutMs: 20000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
