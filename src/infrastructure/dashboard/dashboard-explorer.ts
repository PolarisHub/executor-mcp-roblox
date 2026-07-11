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

/** Shared, guarded reflection helpers for the script workspace. */
const SCRIPT_REFLECTION = `
local __debug = type(debug) == "table" and debug or {}
local __getprotos = (type(getprotos) == "function" and getprotos) or __debug.getprotos
local __getconstants = (type(getconstants) == "function" and getconstants) or __debug.getconstants
local __getupvalues = (type(getupvalues) == "function" and getupvalues) or __debug.getupvalues
local __getinfo = (type(getinfo) == "function" and getinfo) or __debug.getinfo
local __getscriptclosure = (type(getscriptclosure) == "function" and getscriptclosure)
  or (type(getscriptfunction) == "function" and getscriptfunction)

local function __protoList(fn)
  if type(__getprotos) ~= "function" or type(fn) ~= "function" then return {} end
  local ok, values = pcall(__getprotos, fn)
  if not ok or type(values) ~= "table" then return {} end
  local out = {}
  for _, value in ipairs(values) do
    if type(value) == "function" then out[#out + 1] = value end
  end
  return out
end

local function __functionInfo(fn)
  local result = {
    name = "",
    source = "",
    shortSource = "",
    lineDefined = -1,
    lastLineDefined = -1,
    numParams = -1,
    isVararg = false,
  }
  if type(fn) ~= "function" then return result end

  if type(__getinfo) == "function" then
    local ok, info = pcall(__getinfo, fn, "nSlu")
    if ok and type(info) == "table" then
      result.name = info.name or result.name
      result.source = info.source or result.source
      result.shortSource = info.short_src or info.shortSource or result.shortSource
      result.lineDefined = info.linedefined or info.lineDefined or result.lineDefined
      result.lastLineDefined = info.lastlinedefined or info.lastLineDefined or result.lastLineDefined
      result.numParams = info.nparams or info.numparams or result.numParams
      result.isVararg = info.isvararg == true
    end
  end

  -- Roblox-style debug.info returns individual values rather than a table.
  if type(__debug.info) == "function" then
    if result.source == "" then
      local ok, value = pcall(__debug.info, fn, "s")
      if ok and value ~= nil then result.source = tostring(value) end
    end
    if result.name == "" then
      local ok, value = pcall(__debug.info, fn, "n")
      if ok and value ~= nil then result.name = tostring(value) end
    end
    if result.lineDefined < 0 then
      local ok, value = pcall(__debug.info, fn, "l")
      if ok and type(value) == "number" then result.lineDefined = value end
    end
    if result.numParams < 0 then
      local ok, params, vararg = pcall(__debug.info, fn, "a")
      if ok and type(params) == "number" then
        result.numParams = params
        result.isVararg = vararg == true
      end
    end
  end
  if result.shortSource == "" then result.shortSource = result.source end
  return result
end

local function __pathExpression(inst)
  if typeof(inst) ~= "Instance" then return nil end
  if inst == game then return "game" end
  local names = {}
  local cursor = inst
  local guard = 0
  while cursor and cursor ~= game and guard < 128 do
    names[#names + 1] = cursor.Name
    cursor = cursor.Parent
    guard = guard + 1
  end
  if cursor ~= game then return nil end
  local expression = "game"
  for i = #names, 1, -1 do
    expression = expression .. "[" .. string.format("%q", names[i]) .. "]"
  end
  return expression
end

local function __originScript(fn, fallback)
  if type(fn) == "function" and type(getfenv) == "function" then
    local ok, env = pcall(getfenv, fn)
    if ok and type(env) == "table" and typeof(rawget(env, "script")) == "Instance" then
      local candidate = rawget(env, "script")
      if candidate:IsA("LuaSourceContainer") then return candidate end
    end
  end
  if typeof(fallback) == "Instance" and fallback:IsA("LuaSourceContainer") then return fallback end
  return nil
end

local function __originInfo(fn, fallback)
  local info = __functionInfo(fn)
  local origin = __originScript(fn, fallback)
  local result = {
    name = info.name,
    source = info.source,
    shortSource = info.shortSource,
    lineDefined = info.lineDefined,
    lastLineDefined = info.lastLineDefined,
    numParams = info.numParams,
    isVararg = info.isVararg,
  }
  if origin then
    result.originName = origin.Name
    result.originClass = origin.ClassName
    result.originExpression = __pathExpression(origin)
    local ok, fullName = pcall(function() return origin:GetFullName() end)
    if ok then result.originFullName = fullName end
  end
  return result
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
 * Decompile one script and build a bounded, static proto tree around its main
 * closure. The source and reflection payload are capped before crossing the
 * bridge so a large script cannot freeze the dashboard or executor.
 */
export function scriptInspectionLuau(path: string): string {
  return `${RESOLVE}
${SCRIPT_REFLECTION}
local pathStr = ${q(path)}
local scriptInstance, err = __resolve(pathStr)
if err then return { error = err } end
if not scriptInstance:IsA("LuaSourceContainer") then
  return { error = "Resolved instance is not a LuaSourceContainer (Script, LocalScript, or ModuleScript)." }
end
if scriptInstance:IsA("Script") and scriptInstance.RunContext == Enum.RunContext.Server then
  return { error = "Resolved instance is a server Script; only client-side scripts can be decompiled." }
end

local MAX_SOURCE_CHARS = 350000
local MAX_SOURCE_LINES = 6000
local MAX_FUNCTIONS = 320
local MAX_DEPTH = 10
local source = ""
local sourceError = nil
if type(decompile) ~= "function" then
  sourceError = "decompile is not available in this executor."
else
  local ok, value = pcall(decompile, scriptInstance)
  if ok and type(value) == "string" then source = value
  else sourceError = "Failed to decompile script: " .. tostring(value) end
end

local _, newlineCount = source:gsub("\\n", "")
local fullLineCount = (#source > 0) and (newlineCount + 1) or 0
local sourceTruncated = #source > MAX_SOURCE_CHARS
local sourceForLines = sourceTruncated and source:sub(1, MAX_SOURCE_CHARS) or source
local sourceLines = {}
if #sourceForLines > 0 then
  for line in (sourceForLines .. "\\n"):gmatch("(.-)\\n") do
    if #sourceLines >= MAX_SOURCE_LINES then sourceTruncated = true; break end
    sourceLines[#sourceLines + 1] = line
  end
end
local returnedSource = table.concat(sourceLines, "\\n")

local nodes = {}
local reflectionError = nil
local reflectionTruncated = false
local closure = nil
if type(__getscriptclosure) ~= "function" then
  reflectionError = "getscriptclosure (and getscriptfunction) are not available in this executor."
else
  local ok, value = pcall(__getscriptclosure, scriptInstance)
  if ok and type(value) == "function" then closure = value
  else reflectionError = "Could not read the script closure: " .. tostring(value) end
end

if closure then
  local stack = {{ fn = closure, id = "root", parentId = nil, depth = 0, protoIndex = 0 }}
  local seen = {}
  while #stack > 0 and #nodes < MAX_FUNCTIONS do
    local item = table.remove(stack)
    if not seen[item.fn] then
      seen[item.fn] = true
      local info = __originInfo(item.fn, scriptInstance)
      local protos = __protoList(item.fn)
      local constantCount = 0
      local constantsPreview = {}
      if type(__getconstants) == "function" then
        local ok, values = pcall(__getconstants, item.fn)
        if ok and type(values) == "table" then
          for _, value in pairs(values) do
            constantCount = constantCount + 1
            local valueType = typeof(value)
            if #constantsPreview < 10 and (valueType == "string" or valueType == "number" or valueType == "boolean") then
              local preview = tostring(value)
              if #preview > 120 then preview = preview:sub(1, 117) .. "..." end
              constantsPreview[#constantsPreview + 1] = { type = valueType, value = preview }
            end
          end
        end
      end

      local upvalueCount = 0
      local functionRefs = {}
      if type(__getupvalues) == "function" then
        local ok, values = pcall(__getupvalues, item.fn)
        if ok and type(values) == "table" then
          for slot, value in pairs(values) do
            upvalueCount = upvalueCount + 1
            if type(value) == "function" and #functionRefs < 10 then
              local ref = __originInfo(value, nil)
              ref.slot = tostring(slot)
              functionRefs[#functionRefs + 1] = ref
            end
          end
        end
      end

      local line = info.lineDefined
      local displayLine = (type(line) == "number" and line >= 1 and line <= #sourceLines) and line or nil
      if not displayLine and info.name ~= "" then
        local best = nil
        for lineIndex = 1, #sourceLines do
          if sourceLines[lineIndex]:find(info.name, 1, true) then
            if not best or (line >= 1 and math.abs(lineIndex - line) < math.abs(best - line)) then best = lineIndex end
          end
        end
        displayLine = best
      end
      if not displayLine and #sourceLines > 0 then displayLine = 1 end

      nodes[#nodes + 1] = {
        id = item.id,
        parentId = item.parentId,
        depth = item.depth,
        protoIndex = item.protoIndex,
        name = info.name,
        source = info.source,
        shortSource = info.shortSource,
        lineDefined = info.lineDefined,
        lastLineDefined = info.lastLineDefined,
        displayLine = displayLine,
        lineExact = displayLine ~= nil and displayLine == info.lineDefined,
        numParams = info.numParams,
        isVararg = info.isVararg,
        originName = info.originName,
        originClass = info.originClass,
        originExpression = info.originExpression,
        originFullName = info.originFullName,
        directProtoCount = #protos,
        descendantProtoCount = 0,
        constantCount = constantCount,
        upvalueCount = upvalueCount,
        constantsPreview = constantsPreview,
        functionRefs = functionRefs,
      }

      if item.depth < MAX_DEPTH then
        for i = #protos, 1, -1 do
          stack[#stack + 1] = {
            fn = protos[i],
            id = item.id == "root" and tostring(i) or (item.id .. "." .. tostring(i)),
            parentId = item.id,
            depth = item.depth + 1,
            protoIndex = i,
          }
        end
      elseif #protos > 0 then
        reflectionTruncated = true
      end
    end
  end
  if #stack > 0 then reflectionTruncated = true end
end

local nodeById = {}
local totalConstants = 0
local totalUpvalues = 0
for _, node in ipairs(nodes) do
  nodeById[node.id] = node
  totalConstants = totalConstants + node.constantCount
  totalUpvalues = totalUpvalues + node.upvalueCount
end
for _, node in ipairs(nodes) do
  local parentId = node.parentId
  while parentId do
    local parent = nodeById[parentId]
    if not parent then break end
    parent.descendantProtoCount = parent.descendantProtoCount + 1
    parentId = parent.parentId
  end
end

local okFull, fullName = pcall(function() return scriptInstance:GetFullName() end)
return {
  ok = true,
  script = {
    name = scriptInstance.Name,
    class = scriptInstance.ClassName,
    path = pathStr,
    expression = __pathExpression(scriptInstance) or pathStr,
    fullName = okFull and fullName or tostring(scriptInstance),
  },
  source = returnedSource,
  sourceError = sourceError,
  sourceTruncated = sourceTruncated,
  sourceLineCount = fullLineCount,
  returnedLineCount = #sourceLines,
  functions = {
    nodes = nodes,
    protoCount = math.max(0, #nodes - 1),
    totalFunctions = #nodes,
    totalConstants = totalConstants,
    totalUpvalues = totalUpvalues,
    truncated = reflectionTruncated,
    error = reflectionError,
    limits = { maxFunctions = MAX_FUNCTIONS, maxDepth = MAX_DEPTH },
  },
  capabilities = {
    decompile = type(decompile) == "function",
    closure = type(__getscriptclosure) == "function",
    protos = type(__getprotos) == "function",
    constants = type(__getconstants) == "function",
    upvalues = type(__getupvalues) == "function",
    references = type(getgc) == "function" and (type(__getupvalues) == "function" or type(__getprotos) == "function"),
  },
}`;
}

/** Build a bounded reverse-reference scan for one stable proto id. */
export function functionReferencesLuau(
  path: string,
  functionId: string,
  maxScanned: number,
): string {
  return `${RESOLVE}
${SCRIPT_REFLECTION}
local pathStr = ${q(path)}
local functionId = ${q(functionId)}
local MAX_SCANNED = ${maxScanned}
local MAX_RESULTS = 80
local MAX_SECONDS = 2.5
local scriptInstance, err = __resolve(pathStr)
if err then return { error = err } end
if not scriptInstance:IsA("LuaSourceContainer") then return { error = "Resolved instance is not a script." } end
if type(__getscriptclosure) ~= "function" then return { error = "getscriptclosure is not available in this executor." } end

local okClosure, target = pcall(__getscriptclosure, scriptInstance)
if not okClosure or type(target) ~= "function" then return { error = "Could not read the script closure: " .. tostring(target) } end
if functionId ~= "root" then
  for segment in functionId:gmatch("[^.]+") do
    local index = tonumber(segment)
    if not index or index < 1 then return { error = "Invalid function id." } end
    local protos = __protoList(target)
    target = protos[index]
    if type(target) ~= "function" then return { error = "Function id no longer resolves; refresh the script tab." } end
  end
end
if type(getgc) ~= "function" then return { error = "getgc is not available in this executor." } end

local okGc, objects = pcall(getgc, false)
if not okGc or type(objects) ~= "table" then return { error = "getgc failed: " .. tostring(objects) } end
local refs = {}
local seenRefs = {}
local scanned = 0
local truncated = false
local timedOut = false
local started = os.clock()

local function addRef(candidate, relation, slot)
  local key = tostring(candidate) .. ":" .. relation .. ":" .. tostring(slot)
  if seenRefs[key] or #refs >= MAX_RESULTS then return end
  seenRefs[key] = true
  local info = __originInfo(candidate, nil)
  info.relation = relation
  info.slot = tostring(slot)
  refs[#refs + 1] = info
end

for _, candidate in pairs(objects) do
  if type(candidate) == "function" and candidate ~= target then
    scanned = scanned + 1
    if type(__getupvalues) == "function" then
      local ok, values = pcall(__getupvalues, candidate)
      if ok and type(values) == "table" then
        for slot, value in pairs(values) do
          if value == target then addRef(candidate, "upvalue", slot) end
        end
      end
    end
    if type(__getprotos) == "function" then
      local protos = __protoList(candidate)
      for index, proto in ipairs(protos) do
        if proto == target then addRef(candidate, "proto", index) end
      end
    end
    if scanned % 200 == 0 and type(task) == "table" and type(task.wait) == "function" then task.wait() end
    if scanned >= MAX_SCANNED then truncated = true; break end
    if os.clock() - started >= MAX_SECONDS then truncated = true; timedOut = true; break end
    if #refs >= MAX_RESULTS then truncated = true; break end
  end
end

-- Some executors omit env.script. Resolve exact debug source names lazily so
-- reference rows can still open the owning script in a new dashboard tab.
local unresolved = false
for _, ref in ipairs(refs) do if not ref.originExpression then unresolved = true; break end end
if unresolved and type(getscripts) == "function" then
  local byFull = {}
  local byName = {}
  local duplicateNames = {}
  local ok, scripts = pcall(getscripts)
  if ok and type(scripts) == "table" then
    local indexed = 0
    for _, candidate in pairs(scripts) do
      if indexed >= 1200 then break end
      if typeof(candidate) == "Instance" and candidate:IsA("LuaSourceContainer") then
        indexed = indexed + 1
        local okName, full = pcall(function() return candidate:GetFullName() end)
        if okName then byFull[full] = candidate end
        if byName[candidate.Name] then duplicateNames[candidate.Name] = true else byName[candidate.Name] = candidate end
      end
    end
    for _, ref in ipairs(refs) do
      if not ref.originExpression and type(ref.source) == "string" then
        local sourceName = ref.source:gsub("^[=@]", "")
        local origin = byFull[sourceName]
        if not origin and not duplicateNames[sourceName] then origin = byName[sourceName] end
        if origin then
          ref.originName = origin.Name
          ref.originClass = origin.ClassName
          ref.originExpression = __pathExpression(origin)
          local okFull, full = pcall(function() return origin:GetFullName() end)
          if okFull then ref.originFullName = full end
        end
      end
    end
  end
end

return {
  ok = true,
  functionId = functionId,
  target = __originInfo(target, scriptInstance),
  references = refs,
  scannedFunctions = scanned,
  resultLimit = MAX_RESULTS,
  scanLimit = MAX_SCANNED,
  truncated = truncated,
  timedOut = timedOut,
}`;
}

/**
 * Runs live game-tree and bounded script-analysis queries on a chosen connected
 * client via the execution gateway. Used by the dashboard Explorer.
 */
export class ExplorerService {
  constructor(
    private readonly gateway: ExecutionGateway,
    private readonly clients: ClientDirectory,
  ) {}

  private run(clientId: string, source: string, timeoutMs = 20000): Promise<unknown> {
    const id = ClientId(clientId);
    if (!this.clients.get(id)) {
      return Promise.reject(new ClientNotFoundError(`Client "${clientId}" is not connected.`));
    }
    return this.gateway.eval(id, { source, threadContext: 8, timeoutMs });
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
  script(clientId: string, path: string): Promise<unknown> {
    return this.run(clientId, scriptInspectionLuau(path || "game"), 60000);
  }
  references(
    clientId: string,
    path: string,
    functionId: string,
    opts: { maxScanned?: number } = {},
  ): Promise<unknown> {
    const id = functionId.trim();
    if (!/^(?:root|\d+(?:\.\d+)*)$/.test(id)) {
      return Promise.resolve({
        error: "Invalid function id; refresh the script tab and try again.",
      });
    }
    const maxScanned = Math.min(8000, Math.max(200, Math.floor(opts.maxScanned ?? 3500)));
    return this.run(clientId, functionReferencesLuau(path || "game", id, maxScanned), 30000);
  }
}
