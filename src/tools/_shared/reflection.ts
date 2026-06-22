/**
 * Shared helpers for the metatable / closure / environment toolkit.
 *
 * These tools operate BY REFERENCE: you give a Luau expression that evaluates to
 * the target (a table/instance/userdata for metatable tools, a function for
 * closure tools), and the tool inspects or mutates it directly. This complements
 * the gc-scan tools (which find functions across the whole GC).
 *
 * Every tool prepends REFLECT_PRELUDE, which defines guarded helpers:
 *   __eval(expr)        -> value | nil, err     (evaluates `return <expr>`)
 *   __evalFn(expr)      -> fn | nil, err         (must resolve to a function)
 *   __encVal(v)         -> serializable scalar/string
 *   __fnInfo(fn)        -> { IsLua, IsC, Name, Source, ShortSource, LineDefined,
 *                            NumParams, IsVararg, NumUpvalues, Pointer }
 * plus localized capability handles (__getrawmt, __getconstants, …) that are nil
 * when the executor lacks them, so tools can report a clean { error }.
 */

import { z } from "zod";
import { q } from "./luau.js";

export { q };

export const REFLECT_PRELUDE = `
local __hasDebug = type(debug) == "table"
local __d = __hasDebug and debug or {}
local __getrawmt = getrawmetatable
local __getinfo = (type(getinfo) == "function" and getinfo) or __d.getinfo or __d.info
local __getconstants = getconstants or __d.getconstants
local __getupvalues = getupvalues or __d.getupvalues
local __getprotos = getprotos or __d.getprotos
local __islclosure = islclosure
local __iscclosure = iscclosure

local function __encVal(v)
  local t = typeof(v)
  if t == "Instance" then local ok,n = pcall(function() return v:GetFullName() end); return ok and ("Instance: " .. n) or "<Instance>" end
  if t == "string" or t == "number" or t == "boolean" then return v end
  if t == "nil" then return "nil" end
  if t == "function" then return "function: " .. tostring(v) end
  if t == "table" then return "table: " .. tostring(v) end
  local ok, s = pcall(tostring, v); return ok and (t .. ": " .. tostring(s)) or ("<" .. t .. ">")
end

local function __eval(expr)
  local fn, cerr = loadstring("return " .. expr)
  if not fn then return nil, "compile error in expression: " .. tostring(cerr) end
  local ok, val = pcall(fn)
  if not ok then return nil, "error evaluating expression: " .. tostring(val) end
  return val, nil
end

local function __evalFn(expr)
  local val, err = __eval(expr)
  if err then return nil, err end
  if type(val) ~= "function" then return nil, "expression did not resolve to a function (got " .. typeof(val) .. "): " .. expr end
  return val, nil
end

local function __fnInfo(f)
  if type(f) ~= "function" then return nil end
  local r = {
    Pointer = tostring(f),
    IsLua = (type(__islclosure) == "function") and (pcall(__islclosure, f) and __islclosure(f)) or nil,
    IsC = (type(__iscclosure) == "function") and (pcall(__iscclosure, f) and __iscclosure(f)) or nil,
    Name = "", Source = "", ShortSource = "", LineDefined = -1, NumParams = -1, IsVararg = false, NumUpvalues = -1,
  }
  if type(__getinfo) == "function" then
    local okT, info = pcall(__getinfo, f, "nSlu")
    if okT and type(info) == "table" then
      r.Name = info.name or r.Name
      r.Source = info.source or r.Source
      r.ShortSource = info.short_src or r.ShortSource
      r.LineDefined = info.linedefined or r.LineDefined
      r.NumParams = info.nparams or r.NumParams
      r.IsVararg = info.isvararg == true
      r.NumUpvalues = info.nups or r.NumUpvalues
    else
      local okS, s = pcall(__getinfo, f, "s"); if okS and type(s) ~= "table" and s ~= nil then r.Source = tostring(s) end
      local okL, l = pcall(__getinfo, f, "l"); if okL and type(l) == "number" then r.LineDefined = l end
      local okA, a = pcall(__getinfo, f, "a"); if okA and type(a) == "number" then r.NumParams = a end
      local okN, n = pcall(__getinfo, f, "n"); if okN and type(n) ~= "table" and n ~= nil then r.Name = tostring(n) end
    end
  end
  return r
end
`;

/**
 * Build a single Luau value expression from a structured argument used by the
 * mutating tools (set-closure-upvalue / set-closure-constant / set-rawmetatable).
 *   { kind: "string"|"number"|"boolean", value }
 *   { kind: "nil" }
 *   { kind: "raw", value: "<Luau expression>" }   (e.g. "true", "Vector3.new(0,0,0)", "game.Workspace")
 */
export interface ValueArg {
  kind: "string" | "number" | "boolean" | "nil" | "raw";
  value?: string | number | boolean;
}

export function buildValueExpr(arg: ValueArg): string {
  switch (arg.kind) {
    case "string":
      return q(String(arg.value ?? ""));
    case "number":
      return String(Number(arg.value ?? 0));
    case "boolean":
      return arg.value ? "true" : "false";
    case "nil":
      return "nil";
    case "raw":
      return `(loadstring("return " .. ${q(String(arg.value ?? "nil"))}))()`;
    default:
      return "nil";
  }
}

/**
 * Zod schema for a typed value argument accepted by the mutating reflection
 * tools. Mirrors {@link ValueArg}: a discriminator `kind` plus an optional
 * `value` (string/number/boolean) interpreted per kind by {@link buildValueExpr}.
 */
export const valueArgSchema = z.object({
  kind: z.enum(["string", "number", "boolean", "nil", "raw"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
