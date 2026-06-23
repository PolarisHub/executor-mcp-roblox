import { ClientNotFoundError } from "../../domain/errors/errors.js";
import { ClientId } from "../../domain/shared/ids.js";
import type { ClientDirectory } from "../../application/ports/client-directory.js";
import type { ExecutionGateway } from "../../application/ports/execution-gateway.js";

/** JSON-quote into a Luau string literal (rewrites JSON \\uXXXX -> Luau \\u{XXXX}). */
function q(value: string): string {
  return JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => "\\u{" + h + "}");
}

/** Shared Luau: resolve a path string to an Instance, fail cleanly otherwise. */
const RESOLVE = `
local function __resolve(pathStr)
  local fn = loadstring("return " .. pathStr)
  if not fn then return nil, "could not compile path expression" end
  local ok, inst = pcall(fn)
  if not ok then return nil, "error evaluating path: " .. tostring(inst) end
  if typeof(inst) ~= "Instance" then return nil, "path did not resolve to an Instance (got " .. typeof(inst) .. ")" end
  return inst, nil
end
local function __enc(v)
  local t = typeof(v)
  if t == "Instance" then local o, n = pcall(function() return v:GetFullName() end); return t, (o and n or "<Instance>") end
  if t == "string" or t == "number" or t == "boolean" then return t, v end
  if t == "nil" then return "nil", "nil" end
  local o, s = pcall(tostring, v)
  return t, (o and s or ("<" .. t .. ">"))
end
`;

function childrenLuau(path: string, offset: number, limit: number): string {
  return `${RESOLVE}
local pathStr = ${q(path)}
local inst, err = __resolve(pathStr)
if err then return { error = err } end
local kids = inst:GetChildren()
local total = #kids
local off = ${offset}
local lim = ${limit}
-- Sort first so paging is stable across requests for the same parent.
local sorted = {}
for i = 1, total do sorted[i] = kids[i] end
table.sort(sorted, function(a, b)
  local ok, ord = pcall(function() return (a.ClassName .. a.Name) < (b.ClassName .. b.Name) end)
  return ok and ord or false
end)
local out = {}
local upto = math.min(total, off + lim)
for i = off + 1, upto do
  local c = sorted[i]
  pcall(function()
    local n = c.Name
    local cc = c:GetChildren()
    out[#out + 1] = {
      name = n,
      class = c.ClassName,
      path = pathStr .. "[" .. string.format("%q", n) .. "]",
      childCount = #cc,
      hasChildren = #cc > 0,
    }
  end)
end
return {
  ok = true,
  path = pathStr,
  class = inst.ClassName,
  name = inst.Name,
  totalCount = total,
  offset = off,
  returnedCount = #out,
  hasMore = upto < total,
  children = out,
}`;
}

function propertiesLuau(path: string): string {
  return `${RESOLVE}
local pathStr = ${q(path)}
local inst, err = __resolve(pathStr)
if err then return { error = err } end
local props = {}
if type(getproperties) == "function" then
  local okp, list = pcall(getproperties, inst)
  if okp and type(list) == "table" then
    for k, v in pairs(list) do
      local name = (type(k) == "string") and k or v
      if type(name) == "string" then
        local okr, val = pcall(function() return inst[name] end)
        if okr then local t, ev = __enc(val); props[#props + 1] = { name = name, type = t, value = ev } end
      end
    end
  end
end
table.sort(props, function(a, b) return a.name < b.name end)
local attrs = {}
local oka, at = pcall(function() return inst:GetAttributes() end)
if oka and type(at) == "table" then
  for name, v in pairs(at) do
    if type(name) == "string" then local t, ev = __enc(v); attrs[#attrs + 1] = { name = name, type = t, value = ev } end
  end
  table.sort(attrs, function(a, b) return a.name < b.name end)
end
local full = inst
local okf, fn = pcall(function() return inst:GetFullName() end)
if okf then full = fn end
return { ok = true, path = pathStr, class = inst.ClassName, name = inst.Name, fullName = full, properties = props, attributes = attrs }`;
}

function connectionsLuau(path: string): string {
  return `${RESOLVE}
local pathStr = ${q(path)}
local inst, err = __resolve(pathStr)
if err then return { error = err } end
if type(getconnections) ~= "function" then return { error = "getconnections is not available in this executor." } end
local probe = {
  "Changed","ChildAdded","ChildRemoved","DescendantAdded","DescendantRemoving","AncestryChanged","Destroying","AttributeChanged",
  "Touched","TouchEnded","MouseClick","RightMouseClick","MouseHoverEnter","MouseHoverLeave",
  "Triggered","TriggerEnded","PromptShown","PromptHidden",
  "OnClientEvent","Event","Died","HealthChanged","StateChanged","Running","Jumping","Seated","MoveToFinished",
  "CharacterAdded","CharacterRemoving","Idled","Chatted",
  "Activated","MouseButton1Click","MouseButton1Down","MouseButton1Up","MouseButton2Click","InputBegan","InputEnded",
  "FocusLost","Focused","SelectionGained","SelectionLost","Loaded","Play","Ended",
}
local out = {}
for _, sname in ipairs(probe) do
  local oks, sig = pcall(function() return inst[sname] end)
  if oks and typeof(sig) == "RBXScriptSignal" then
    local okc, conns = pcall(getconnections, sig)
    if okc and type(conns) == "table" and #conns > 0 then
      local entries = {}
      for i = 1, math.min(#conns, 40) do
        local conn = conns[i]
        local info = {}
        pcall(function() info.enabled = conn.Enabled end)
        local f = nil
        pcall(function() f = conn.Function end)
        if type(f) == "function" and type(debug) == "table" and type(debug.info) == "function" then
          pcall(function() info.source = debug.info(f, "s") end)
          pcall(function() info.line = debug.info(f, "l") end)
          pcall(function() local n = debug.info(f, "n"); if n and n ~= "" then info.name = n end end)
        end
        entries[#entries + 1] = info
      end
      out[#out + 1] = { name = sname, count = #conns, connections = entries }
    end
  end
end
return { ok = true, path = pathStr, class = inst.ClassName, name = inst.Name, signals = out }`;
}

/**
 * Runs live game-tree queries (children / properties / connections) on a chosen
 * connected client, via the execution gateway. Used by the dashboard Explorer.
 */
export class ExplorerService {
  constructor(
    private readonly gateway: ExecutionGateway,
    private readonly clients: ClientDirectory,
  ) {}

  private run(clientId: string, source: string): Promise<unknown> {
    const id = ClientId(clientId);
    if (!this.clients.get(id)) {
      return Promise.reject(new ClientNotFoundError(`Client "${clientId}" is not connected.`));
    }
    return this.gateway.eval(id, { source, threadContext: 8, timeoutMs: 20000 });
  }

  children(
    clientId: string,
    path: string,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<unknown> {
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const limit = Math.min(2000, Math.max(1, Math.floor(opts.limit ?? 200)));
    return this.run(clientId, childrenLuau(path || "game", offset, limit));
  }
  properties(clientId: string, path: string): Promise<unknown> {
    return this.run(clientId, propertiesLuau(path || "game"));
  }
  connections(clientId: string, path: string): Promise<unknown> {
    return this.run(clientId, connectionsLuau(path || "game"));
  }
}
