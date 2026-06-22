/**
 * Shared helpers for the IDA-style "Disassembly & Xrefs" toolkit. These tools
 * walk the garbage collector (getgc) to cross-reference Luau functions the way
 * IDA cross-references code: by string/constant, by referenced function/instance,
 * by upvalue, by bytecode pattern, etc.
 *
 * Every tool prepends XREF_PRELUDE and is fully pcall-guarded so one bad object
 * never aborts a whole-heap scan. Tools RETURN A LUA TABLE (the connector
 * JSON-encodes it for the AI) — they do not JSONEncode.
 */

import { q } from "./luau.js";

export { q };

export const XREF_PRELUDE = `
local __d = (type(debug) == "table") and debug or {}
local __getinfo = (type(getinfo) == "function" and getinfo) or __d.getinfo or __d.info
local __getconstants = getconstants or __d.getconstants
local __getupvalues = getupvalues or __d.getupvalues
local __getprotos = getprotos or __d.getprotos

local function __fnInfo(f)
  local r = { ptr = tostring(f), name = "", source = "", line = -1, nparams = -1, nups = -1 }
  if type(__getinfo) == "function" then
    local ok, info = pcall(__getinfo, f, "nSlu")
    if ok and type(info) == "table" then
      r.name = info.name or ""
      r.source = info.source or ""
      r.line = info.linedefined or -1
      r.nparams = info.nparams or -1
      r.nups = info.nups or -1
    else
      local oks, s = pcall(__getinfo, f, "s"); if oks and type(s) ~= "table" and s ~= nil then r.source = tostring(s) end
      local okl, l = pcall(__getinfo, f, "l"); if okl and type(l) == "number" then r.line = l end
      local okn, n = pcall(__getinfo, f, "n"); if okn and n ~= nil and type(n) ~= "table" then r.name = tostring(n) end
    end
  end
  return r
end

local function __consts(f)
  if type(__getconstants) ~= "function" then return {} end
  local ok, c = pcall(__getconstants, f)
  if ok and type(c) == "table" then return c end
  return {}
end
local function __ups(f)
  if type(__getupvalues) ~= "function" then return {} end
  local ok, u = pcall(__getupvalues, f)
  if ok and type(u) == "table" then return u end
  return {}
end
local function __protos(f)
  if type(__getprotos) ~= "function" then return {} end
  local ok, p = pcall(__getprotos, f)
  if ok and type(p) == "table" then return p end
  return {}
end

-- Walk GC functions up to 'cap'; call cb(fn) for each. Returns (truncated, scanned).
local function __eachFn(cap, cb)
  local ok, gc = pcall(getgc, true)
  if not ok or type(gc) ~= "table" then
    ok, gc = pcall(getgc)
    if not ok or type(gc) ~= "table" then return false, 0 end
  end
  local n = 0
  for _, o in gc do
    if type(o) == "function" then
      n = n + 1
      if n > cap then return true, n end
      pcall(cb, o)
    end
  end
  return false, n
end
`;
