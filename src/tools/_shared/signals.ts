/**
 * Shared helpers for the signal/connection toolkit.
 *
 * Every tool in this folder builds a Luau snippet that runs in the Roblox client
 * and returns a serializable table. To stay consistent and robust they all
 * prepend SIGNAL_PRELUDE, which defines a small library of guarded helpers:
 *
 *   __resolveInstance(expr)        -> inst | nil, err
 *   __resolveSignal(expr, name)    -> sig, inst | nil, err   (name "" => expr IS the signal)
 *   __getConns(sig)                -> conns | nil, err
 *   __describeFunction(fn)         -> { Name, Source, ShortSource, LineDefined, NumParams, IsVararg, What, Pointer }
 *   __connInfo(conn, index, withFn)-> info, fn
 *   __encVal(v)                    -> serializable scalar/string
 *
 * The function-description logic mirrors the proven approach in
 * trace-connection-function (debug.info "nSlu" table form, then a
 * field-by-field fallback) so behaviour matches the existing tools.
 */

import { q } from "./luau.js";

export { q };

export const SIGNAL_PRELUDE = `
local __getconnectionsFn = getconnections
local __hasDebug = type(debug) == "table"
local __debugInfoFn = __hasDebug and (debug.info or debug.getinfo) or nil

local function __encVal(v)
  local t = typeof(v)
  if t == "Instance" then local ok,n = pcall(function() return v:GetFullName() end); return ok and n or "<Instance>" end
  if t == "string" or t == "number" or t == "boolean" then return v end
  if t == "nil" then return "nil" end
  local ok, s = pcall(tostring, v); return ok and (t .. ": " .. tostring(s)) or ("<" .. t .. ">")
end

local function __describeFunction(f)
  if type(f) ~= "function" then return nil end
  local result = { Name = "<anonymous>", Source = "", ShortSource = "", LineDefined = -1, NumParams = -1, IsVararg = false, What = "?", Pointer = tostring(f) }
  if type(__debugInfoFn) ~= "function" then return result end
  local okTbl, infoTbl = pcall(__debugInfoFn, f, "nSlu")
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
  local okN, n = pcall(__debugInfoFn, f, "n"); if okN and type(n) ~= "table" and n ~= nil then result.Name = tostring(n) end
  local okS, s = pcall(__debugInfoFn, f, "s"); if okS and type(s) ~= "table" and s ~= nil then result.Source = tostring(s) end
  local okL, l = pcall(__debugInfoFn, f, "l"); if okL and type(l) == "number" then result.LineDefined = l end
  local okA, a = pcall(__debugInfoFn, f, "a"); if okA and type(a) == "number" then result.NumParams = a end
  return result
end

local function __resolveInstance(expr)
  local ok, inst = pcall(function() return (loadstring("return " .. expr))() end)
  if not ok then return nil, "Failed to evaluate path: " .. tostring(inst) end
  if typeof(inst) ~= "Instance" then return nil, "Path did not resolve to an Instance (got " .. typeof(inst) .. "): " .. expr end
  return inst, nil
end

-- Resolve a signal. If signalName is nil/"" the expr itself must be the RBXScriptSignal.
local function __resolveSignal(expr, signalName)
  if signalName == nil or signalName == "" then
    local ok, sig = pcall(function() return (loadstring("return " .. expr))() end)
    if not ok then return nil, nil, "Failed to evaluate signal expression: " .. tostring(sig) end
    if typeof(sig) ~= "RBXScriptSignal" then return nil, nil, "Expression is not an RBXScriptSignal (got " .. typeof(sig) .. "): " .. expr end
    return sig, nil, nil
  end
  local inst, err = __resolveInstance(expr)
  if not inst then return nil, nil, err end
  local okSig, sig = pcall(function() return inst[signalName] end)
  if not okSig then return nil, inst, "Failed to access member '" .. signalName .. "' on " .. inst:GetFullName() .. ": " .. tostring(sig) end
  if typeof(sig) ~= "RBXScriptSignal" then return nil, inst, "Member '" .. signalName .. "' is not an RBXScriptSignal (got " .. typeof(sig) .. ")." end
  return sig, inst, nil
end

local function __getConns(sig)
  if type(__getconnectionsFn) ~= "function" then return nil, "getconnections is not available in this executor." end
  local ok, conns = pcall(__getconnectionsFn, sig)
  if not ok or type(conns) ~= "table" then return nil, "getconnections failed: " .. tostring(conns) end
  return conns, nil
end

local function __connInfo(conn, index, withFn)
  local info = { Index = index }
  local function g(k) local ok, v = pcall(function() return conn[k] end); if ok then return v end return nil end
  info.Enabled = g("Enabled")
  info.LuaConnection = g("LuaConnection")
  info.ForeignState = g("ForeignState")
  local fn = g("Function")
  info.HasFunction = type(fn) == "function"
  local th = g("Thread")
  info.HasThread = th ~= nil
  if th ~= nil then
    local okS, st = pcall(function() return coroutine.status(th) end)
    if okS then info.ThreadStatus = st end
  end
  if withFn and type(fn) == "function" then
    info.Function = __describeFunction(fn)
  end
  return info, fn
end
`;

/**
 * Build a Luau literal arg-list from a structured arguments array, for the
 * firing tools (fire-signal / replicate-signal / fire-connection).
 * Each element is one of:
 *   { kind: "string"|"number"|"boolean", value }
 *   { kind: "nil" }
 *   { kind: "instance", value: "game.Workspace.Part" }   (resolved at runtime)
 *   { kind: "raw", value: "Vector3.new(1,2,3)" }          (raw Luau expression)
 * Returns a string like `arg1, arg2, ...` plus the preamble that defines them,
 * so callers can splice it into a firesignal(...) call.
 */
export interface SignalArg {
  kind: "string" | "number" | "boolean" | "nil" | "instance" | "raw";
  value?: string | number | boolean;
}

export function buildArgList(args: SignalArg[] | undefined): { preamble: string; argExpr: string } {
  if (!args || args.length === 0) return { preamble: "", argExpr: "" };
  const lines: string[] = [];
  const names: string[] = [];
  args.forEach((a, i) => {
    const name = `__arg${i}`;
    names.push(name);
    switch (a.kind) {
      case "string":
        lines.push(`local ${name} = ${q(String(a.value ?? ""))}`);
        break;
      case "number":
        lines.push(`local ${name} = ${Number(a.value ?? 0)}`);
        break;
      case "boolean":
        lines.push(`local ${name} = ${a.value ? "true" : "false"}`);
        break;
      case "nil":
        lines.push(`local ${name} = nil`);
        break;
      case "instance":
        lines.push(`local ${name} = (loadstring("return " .. ${q(String(a.value ?? ""))}))()`);
        break;
      case "raw":
        lines.push(`local ${name} = (loadstring("return " .. ${q(String(a.value ?? "nil"))}))()`);
        break;
      default:
        lines.push(`local ${name} = nil`);
    }
  });
  return { preamble: lines.join("\n"), argExpr: names.join(", ") };
}
