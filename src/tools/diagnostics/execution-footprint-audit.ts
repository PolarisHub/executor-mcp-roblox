import { z } from "zod";

import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

const input = z.object({
  scriptPath: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe("Optional Luau expression resolving to the LocalScript or ModuleScript to audit."),
  functionPath: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Optional Luau expression resolving to a function/closure to audit without invoking it.",
    ),
  includeSourceScan: z
    .boolean()
    .optional()
    .default(true)
    .describe("Read and scan a bounded script.Source prefix when the property is accessible."),
  includeStackEnvironments: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Inspect key names from a bounded number of the auditor's current getfenv stack frames.",
    ),
  maxStackFrames: z
    .number()
    .int()
    .min(0)
    .max(32)
    .optional()
    .default(8)
    .describe(
      "Maximum current auditor stack levels inspected with getfenv (0 disables stack probing).",
    ),
  maxEvidence: z
    .number()
    .int()
    .min(10)
    .max(250)
    .optional()
    .default(100)
    .describe("Hard cap for findings and source/constant evidence records."),
  maxEnvironmentKeys: z
    .number()
    .int()
    .min(10)
    .max(400)
    .optional()
    .default(120)
    .describe("Maximum key names retained from each unique environment."),
  maxSourceChars: z
    .number()
    .int()
    .min(1000)
    .max(200000)
    .optional()
    .default(60000)
    .describe("Maximum script.Source characters scanned; the report says when this truncates."),
  maxConstants: z
    .number()
    .int()
    .min(0)
    .max(256)
    .optional()
    .default(96)
    .describe("Maximum target-closure constants inspected internally."),
  maxUpvalues: z
    .number()
    .int()
    .min(0)
    .max(128)
    .optional()
    .default(64)
    .describe("Maximum target-closure upvalues classified without returning captured values."),
  threadContext: z.number().int().optional(),
});

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value ?? fallback)));
}

export default defineTool({
  name: "execution-footprint-audit",
  title: "Audit script execution footprint and local detection exposure",
  description:
    "READ-ONLY, one-shot Luau auditor for local execution exposure. It resolves an optional script and/or closure " +
    "without invoking it; inventories virtual-input globals and VirtualInputManager/VirtualUser references; " +
    "distinguishes direct Instance references from cloneref-like alternate references when compareinstances exists; " +
    "compares input functions with retained MCP closure handles; audits bounded getsenv/getfenv key-name leaks; " +
    "classifies closure origin/hash/hook state; scans bounded source/constants for input, environment, debug, and hook " +
    "indicators; and returns findings, unknown checks, confidence, risk score, privacy-safe evidence, and truncation " +
    "telemetry. It never sends input, calls the target closure, walks getgc/descendants, installs hooks, or writes " +
    "to game objects or script values. A clean result does NOT prove that server-side or external detection did not occur, and cloneref/clone " +
    "matches are provenance only—not an undetectability guarantee.",
  category: "Diagnostics",
  input,
  async execute(
    {
      scriptPath,
      functionPath,
      includeSourceScan,
      includeStackEnvironments,
      maxStackFrames,
      maxEvidence,
      maxEnvironmentKeys,
      maxSourceChars,
      maxConstants,
      maxUpvalues,
      threadContext,
    },
    ctx,
  ) {
    const stackLimit = bounded(maxStackFrames, 8, 0, 32);
    const evidenceLimit = bounded(maxEvidence, 100, 10, 250);
    const environmentKeyLimit = bounded(maxEnvironmentKeys, 120, 10, 400);
    const sourceCharLimit = bounded(maxSourceChars, 60000, 1000, 200000);
    const constantLimit = bounded(maxConstants, 96, 0, 256);
    const upvalueLimit = bounded(maxUpvalues, 64, 0, 128);
    const scanSource = includeSourceScan !== false;
    const scanStack = includeStackEnvironments !== false && stackLimit > 0;

    const source = `
local CONFIG = {
  scriptExpression = ${q(scriptPath ?? "")},
  functionExpression = ${q(functionPath ?? "")},
  includeSourceScan = ${scanSource ? "true" : "false"},
  includeStackEnvironments = ${scanStack ? "true" : "false"},
  maxStackFrames = ${stackLimit},
  maxEvidence = ${evidenceLimit},
  maxEnvironmentKeys = ${environmentKeyLimit},
  maxSourceChars = ${sourceCharLimit},
  maxConstants = ${constantLimit},
  maxUpvalues = ${upvalueLimit},
  maxRetainedRefs = ${Math.min(environmentKeyLimit, 160)},
  maxUnknownChecks = ${Math.min(evidenceLimit, 100)},
}

local function now()
  local ok, value = pcall(function() return os.clock() end)
  return ok and type(value) == "number" and value or 0
end

local startedAt = now()
local report = {
  version = "1.0",
  kind = "execution-footprint-audit",
  disclaimer = "Local read-only exposure audit only; this cannot prove server-side or external detection.",
  assessment = {
    localExposureOnly = true,
    detectionProven = false,
    cleanReportGuaranteesUndetected = false,
    cloneOrClonerefGuaranteesSafety = false,
  },
  target = {
    scriptExpression = CONFIG.scriptExpression ~= "" and CONFIG.scriptExpression or nil,
    functionExpression = CONFIG.functionExpression ~= "" and CONFIG.functionExpression or nil,
    script = nil,
    explicitFunction = nil,
    selectedClosure = nil,
  },
  capabilities = {},
  virtualInput = {
    globals = {},
    services = {},
    targetReferences = {},
    retainedRegistry = { available = false, scanned = 0, truncated = false },
    note = "Reference matches are provenance only and never prove undetectability.",
  },
  environments = {
    targetScript = nil,
    targetFunction = nil,
    currentStack = {},
    uniqueCurrent = {},
    note = "getfenv stack entries describe this auditor's current stack, not an uninvoked target closure.",
  },
  closure = nil,
  sourceIndicators = {},
  findings = {},
  unknownChecks = {},
  notes = {
    "No target function is invoked.",
    "No virtual input is sent.",
    "No hook or persistent connection is installed.",
    "Environment and upvalue values are never serialized.",
  },
  telemetry = {
    oneLuauCall = true,
    noTargetInvocation = true,
    noInputSent = true,
    noHooksInstalled = true,
    noGcScan = true,
    noDescendantScan = true,
    getfenvUsed = false,
    scanned = {
      inputGlobals = 0,
      retainedRefs = 0,
      environmentKeys = 0,
      stackFrames = 0,
      sourceChars = 0,
      sourceLines = 0,
      constants = 0,
      upvalues = 0,
    },
    limits = {
      evidence = CONFIG.maxEvidence,
      environmentKeysPerEnvironment = CONFIG.maxEnvironmentKeys,
      stackFrames = CONFIG.maxStackFrames,
      sourceChars = CONFIG.maxSourceChars,
      constants = CONFIG.maxConstants,
      upvalues = CONFIG.maxUpvalues,
      retainedRefs = CONFIG.maxRetainedRefs,
    },
    truncation = {
      evidence = false,
      environments = false,
      source = false,
      constants = false,
      upvalues = false,
      retainedRefs = false,
      unknownChecks = false,
    },
  },
}

local riskPoints = 0
local confirmedFindingCount = 0
local heuristicFindingCount = 0
local findingKeys = {}
local unknownKeys = {}
local evidenceCount = 0
local sourceEvidenceLimit = math.max(1, math.floor(CONFIG.maxEvidence / 2))

local function text(value, limit)
  local ok, rendered = pcall(tostring, value)
  rendered = ok and rendered or "<unprintable>"
  limit = limit or 180
  if #rendered > limit then return string.sub(rendered, 1, limit) .. "…" end
  return rendered
end

local function lower(value)
  return string.lower(text(value, 256))
end

local function sensitiveName(name)
  local value = lower(name)
  local terms = { "password", "passwd", "secret", "cookie", "authorization", "bearer", "access_token", "refresh_token", "api_key", "apikey", "private_key" }
  for _, term in ipairs(terms) do
    if string.find(value, term, 1, true) then return true end
  end
  return false
end

local function safeKeyName(name)
  if sensitiveName(name) then return "<redacted-sensitive-key-name>" end
  return text(name, 96)
end

local function redactSnippet(value)
  local snippet = text(value, 240)
  snippet = string.gsub(snippet, "https?://%S+", "<url:redacted>")
  snippet = string.gsub(snippet, '"(.-)"', '"<redacted:string>"')
  snippet = string.gsub(snippet, "'(.-)'", "'<redacted:string>'")
  return snippet
end

local function addUnknown(check, reason)
  local key = tostring(check)
  if unknownKeys[key] then return end
  if #report.unknownChecks >= CONFIG.maxUnknownChecks then
    report.telemetry.truncation.unknownChecks = true
    return
  end
  unknownKeys[key] = true
  report.unknownChecks[#report.unknownChecks + 1] = {
    check = text(check, 80),
    reason = text(reason, 220),
  }
end

local function addFinding(id, category, severity, confidence, confirmed, title, evidence, points)
  local key = tostring(id)
  if findingKeys[key] then return end
  if evidenceCount >= CONFIG.maxEvidence then
    report.telemetry.truncation.evidence = true
    return
  end
  findingKeys[key] = true
  report.findings[#report.findings + 1] = {
    id = key,
    category = category,
    severity = severity,
    confidence = confidence,
    confirmed = confirmed == true,
    title = text(title, 180),
    evidence = text(evidence, 300),
    points = math.max(0, math.floor(tonumber(points) or 0)),
  }
  evidenceCount = evidenceCount + 1
  riskPoints = riskPoints + math.max(0, math.floor(tonumber(points) or 0))
  if confirmed == true then confirmedFindingCount = confirmedFindingCount + 1 else heuristicFindingCount = heuristicFindingCount + 1 end
end

local function instanceInfo(value)
  if typeof(value) ~= "Instance" then return nil end
  local path = nil
  local okPath, fullPath = pcall(function() return value:GetFullName() end)
  if okPath then path = text(fullPath, 240) end
  local className = nil
  local okClass, classValue = pcall(function() return value.ClassName end)
  if okClass then className = text(classValue, 80) end
  return { className = className, path = path }
end

local hosts = {}
local genvEnvironment = nil
local renvEnvironment = nil
local function addHost(label, value)
  if type(value) ~= "table" then return end
  for _, host in ipairs(hosts) do if host.value == value then return end end
  hosts[#hosts + 1] = { label = label, value = value }
end

if type(getgenv) == "function" then
  local ok, value = pcall(getgenv)
  if ok and type(value) == "table" then genvEnvironment = value; addHost("getgenv", value) end
end
if type(getrenv) == "function" then
  local ok, value = pcall(getrenv)
  if ok and type(value) == "table" then renvEnvironment = value; addHost("getrenv", value) end
end
addHost("_G", _G)

local function resolveName(name)
  local parts = {}
  for part in string.gmatch(name, "[^%.]+") do parts[#parts + 1] = part end
  for _, host in ipairs(hosts) do
    local current = host.value
    local valid = true
    for _, part in ipairs(parts) do
      if type(current) ~= "table" then valid = false; break end
      local ok, nextValue = pcall(function() return current[part] end)
      if not ok then valid = false; break end
      current = nextValue
    end
    if valid and current ~= nil then return current, host.label end
  end
  if type(loadstring) == "function" then
    local okCompile, loader = pcall(loadstring, "return " .. name)
    if okCompile and type(loader) == "function" then
      local okValue, value = pcall(loader)
      if okValue and value ~= nil then return value, "loadstring" end
    end
  end
  return nil, nil
end

local function firstFunction(names)
  for _, name in ipairs(names) do
    local value, host = resolveName(name)
    if type(value) == "function" then return value, name, host end
  end
  return nil, nil, nil
end

local CAPABILITY_SPECS = {
  getgenv = { "getgenv" },
  getrenv = { "getrenv" },
  getfenv = { "getfenv" },
  getsenv = { "getsenv" },
  getcallingscript = { "getcallingscript" },
  getscriptclosure = { "getscriptclosure" },
  getscripthash = { "getscripthash" },
  cloneref = { "cloneref" },
  compareinstances = { "compareinstances" },
  getinfo = { "getinfo", "debug.getinfo", "debug.info" },
  getconstants = { "getconstants", "debug.getconstants" },
  getupvalues = { "getupvalues", "debug.getupvalues" },
  iscclosure = { "iscclosure" },
  islclosure = { "islclosure" },
  isexecutorclosure = { "isexecutorclosure", "checkclosure", "isourclosure" },
  isnewcclosure = { "isnewcclosure", "iscustomcclosure" },
  isfunctionhooked = { "isfunctionhooked" },
  getfunctionhash = { "getfunctionhash" },
  loadstring = { "loadstring" },
}

local F = {}
local capabilityNames = {}
for name in pairs(CAPABILITY_SPECS) do capabilityNames[#capabilityNames + 1] = name end
table.sort(capabilityNames)
for _, name in ipairs(capabilityNames) do
  local fn, alias, host = firstFunction(CAPABILITY_SPECS[name])
  F[name] = fn
  report.capabilities[name] = { available = type(fn) == "function", alias = alias, host = host }
end

local function safePredicate(fn, value)
  if type(fn) ~= "function" then return nil end
  local ok, result = pcall(fn, value)
  if not ok then return nil end
  return result == true
end

local function safeHash(fn)
  if type(F.getfunctionhash) ~= "function" or type(fn) ~= "function" then return nil end
  local ok, value = pcall(F.getfunctionhash, fn)
  return ok and value ~= nil and text(value, 160) or nil
end

local function functionInfo(fn)
  if type(fn) ~= "function" then return nil end
  local info = {
    pointer = text(fn, 100),
    isCClosure = safePredicate(F.iscclosure, fn),
    isLClosure = safePredicate(F.islclosure, fn),
    isExecutorClosure = safePredicate(F.isexecutorclosure, fn),
    isNewCClosure = safePredicate(F.isnewcclosure, fn),
    isFunctionHooked = safePredicate(F.isfunctionhooked, fn),
    hash = safeHash(fn),
  }
  if type(F.getinfo) == "function" then
    local ok, value = pcall(F.getinfo, fn, "nSlu")
    if ok and type(value) == "table" then
      info.name = text(value.name or "", 100)
      info.source = text(value.source or "", 220)
      info.shortSource = text(value.short_src or "", 160)
      info.lineDefined = tonumber(value.linedefined)
      info.lastLineDefined = tonumber(value.lastlinedefined)
      info.numberOfParameters = tonumber(value.nparams)
      info.numberOfUpvalues = tonumber(value.nups)
      info.isVararg = value.isvararg == true
    else
      local okSource, source = pcall(F.getinfo, fn, "s")
      if okSource and source ~= nil and type(source) ~= "table" then info.source = text(source, 220) end
      local okLine, line = pcall(F.getinfo, fn, "l")
      if okLine and type(line) == "number" then info.lineDefined = line end
      local okName, name = pcall(F.getinfo, fn, "n")
      if okName and name ~= nil and type(name) ~= "table" then info.name = text(name, 100) end
      local okArity, parameters, isVararg = pcall(F.getinfo, fn, "a")
      if okArity and type(parameters) == "number" then
        info.numberOfParameters = parameters
        info.isVararg = isVararg == true
      end
      if info.source == nil and info.lineDefined == nil and info.name == nil then
        addUnknown("closure-debug-info", "getinfo/debug.info exists but returned no usable metadata")
      end
    end
  else
    addUnknown("closure-debug-info", "getinfo/debug.getinfo unavailable")
  end
  return info
end

local function evaluateExpression(expression, expectedType)
  if expression == "" then return nil, "not requested" end
  if type(F.loadstring) ~= "function" then return nil, "loadstring unavailable" end
  local okCompile, loaderOrError = pcall(F.loadstring, "return " .. expression)
  if not okCompile or type(loaderOrError) ~= "function" then
    return nil, "expression compile failed: " .. text(loaderOrError, 180)
  end
  local okValue, value = pcall(loaderOrError)
  if not okValue then return nil, "expression evaluation failed: " .. text(value, 180) end
  if expectedType and typeof(value) ~= expectedType then
    return nil, "expression resolved to " .. typeof(value) .. ", expected " .. expectedType
  end
  return value, nil
end

local function sameInstanceKind(value, rawService)
  if typeof(value) ~= "Instance" or typeof(rawService) ~= "Instance" then return nil end
  if value == rawService then return "direct" end
  if type(F.compareinstances) == "function" then
    local ok, same = pcall(F.compareinstances, value, rawService)
    if ok and same == true then return "cloned-or-alternate" end
  end
  return nil
end

local services = {}
for _, serviceName in ipairs({ "VirtualInputManager", "VirtualUser", "UserInputService" }) do
  local ok, service = pcall(function() return game:GetService(serviceName) end)
  if ok and typeof(service) == "Instance" then
    services[serviceName] = service
    local info = instanceInfo(service) or {}
    info.name = serviceName
    info.available = true
    if serviceName == "UserInputService" then
      local okMember, member = pcall(function() return service.CreateVirtualInput end)
      info.createVirtualInputMemberAvailable = okMember and type(member) == "function"
    end
    report.virtualInput.services[#report.virtualInput.services + 1] = info
  else
    report.virtualInput.services[#report.virtualInput.services + 1] = { name = serviceName, available = false }
  end
end

if type(F.compareinstances) ~= "function" then
  addUnknown("cloneref-instance-provenance", "compareinstances unavailable; alternate Instance references cannot be distinguished reliably")
end

local retainedRegistry = nil
if type(F.getgenv) == "function" then
  local ok, genv = pcall(F.getgenv)
  if ok and type(genv) == "table" then
    local okRegistry, registry = pcall(function() return genv.__mcp_closure_refs end)
    if okRegistry and type(registry) == "table" then
      retainedRegistry = registry
      report.virtualInput.retainedRegistry.available = true
    end
  end
end

local retainedEntries = {}
if type(retainedRegistry) == "table" then
  local scanned = 0
  local okIter, iterError = pcall(function()
    for _, candidate in pairs(retainedRegistry) do
      if scanned >= CONFIG.maxRetainedRefs then
        report.telemetry.truncation.retainedRefs = true
        report.virtualInput.retainedRegistry.truncated = true
        break
      end
      scanned = scanned + 1
      if type(candidate) == "function" then
        retainedEntries[#retainedEntries + 1] = {
          fn = candidate,
          hash = safeHash(candidate),
          ordinal = scanned,
        }
      end
    end
  end)
  report.telemetry.scanned.retainedRefs = scanned
  report.virtualInput.retainedRegistry.scanned = scanned
  if not okIter then report.virtualInput.retainedRegistry.error = "registry enumeration failed: " .. text(iterError, 120) end
end

local function retainedFunctionMatch(fn, hash)
  if type(retainedRegistry) ~= "table" then
    return { available = false, matched = false, note = "retained closure registry unavailable" }
  end
  local result = { available = true, matched = false, matchKind = nil, ordinal = nil }
  for _, candidate in ipairs(retainedEntries) do
    if candidate.fn == fn then
      result.matched = true
      result.matchKind = "identity"
      result.ordinal = candidate.ordinal
      break
    elseif hash ~= nil and candidate.hash == hash then
      result.matched = true
      result.matchKind = "hash"
      result.ordinal = candidate.ordinal
      break
    end
  end
  return result
end

local INPUT_NAMES = {
  "iswindowactive",
  "keypress", "keyrelease", "keyclick",
  "mouse1press", "mouse1release", "mouse1click",
  "mouse2press", "mouse2release", "mouse2click",
  "mousescroll", "mousemoverel", "mousemoveabs",
}

local inputByName = {}
for _, name in ipairs(INPUT_NAMES) do
  report.telemetry.scanned.inputGlobals = report.telemetry.scanned.inputGlobals + 1
  local value, host = resolveName(name)
  local entry = { name = name, available = type(value) == "function", host = host }
  if type(value) == "function" then
    entry.functionInfo = functionInfo(value)
    entry.retainedReference = retainedFunctionMatch(value, entry.functionInfo and entry.functionInfo.hash or nil)
    inputByName[name] = { fn = value, report = entry }
    if entry.functionInfo and entry.functionInfo.isFunctionHooked == true then
      addFinding(
        "input-global-hooked-" .. name,
        "virtual-input",
        "medium",
        "confirmed-local",
        true,
        "Virtual-input global reports as hooked",
        name .. " returned true from isfunctionhooked; the function was not called.",
        12
      )
    end
  end
  report.virtualInput.globals[#report.virtualInput.globals + 1] = entry
end

local usedInputNames = {}
local environmentIds = {}
local environmentSequence = 0

local PRIVILEGED_NAMES = {
  getgenv = true, getrenv = true, getfenv = true, getsenv = true, getgc = true,
  hookfunction = true, hookmetamethod = true, newcclosure = true, getrawmetatable = true,
  getcallingscript = true, getscriptclosure = true, request = true, http_request = true,
  cloneref = true, compareinstances = true, shared = true, identifyexecutor = true,
  getexecutorname = true, getexecutorinfo = true, gethui = true, syn = true, fluxus = true,
  krnl = true, websocket = true,
}
for _, inputName in ipairs(INPUT_NAMES) do PRIVILEGED_NAMES[inputName] = true end

local function environmentId(environment)
  if type(environment) ~= "table" then return nil end
  for _, pair in ipairs(environmentIds) do
    if pair.value == environment then return pair.id end
  end
  environmentSequence = environmentSequence + 1
  local id = "env-" .. tostring(environmentSequence)
  environmentIds[#environmentIds + 1] = { value = environment, id = id }
  return id
end

local function inspectEnvironment(label, environment, targetScoped)
  if type(environment) ~= "table" then return nil end
  local output = {
    label = label,
    environmentId = environmentId(environment),
    sameAsGetgenv = genvEnvironment ~= nil and environment == genvEnvironment,
    sameAsGetrenv = renvEnvironment ~= nil and environment == renvEnvironment,
    sameAsGlobalG = type(_G) == "table" and environment == _G,
    keyCount = 0,
    keys = {},
    privilegedKeys = {},
    inputBindings = {},
    serviceReferences = {},
    redactedSensitiveKeyNames = 0,
    truncated = false,
  }
  local privilegedSeen = {}
  local inputSeen = {}
  local okIter, iterError = pcall(function()
    for key, value in pairs(environment) do
      if output.keyCount >= CONFIG.maxEnvironmentKeys then
        output.truncated = true
        report.telemetry.truncation.environments = true
        break
      end
      output.keyCount = output.keyCount + 1
      report.telemetry.scanned.environmentKeys = report.telemetry.scanned.environmentKeys + 1
      if type(key) == "string" then
        local renderedKey = safeKeyName(key)
        if renderedKey == "<redacted-sensitive-key-name>" then output.redactedSensitiveKeyNames = output.redactedSensitiveKeyNames + 1 end
        output.keys[#output.keys + 1] = renderedKey
        local normalized = string.lower(key)
        if (PRIVILEGED_NAMES[normalized] or string.sub(normalized, 1, 6) == "__mcp_") and not privilegedSeen[normalized] then
          privilegedSeen[normalized] = true
          output.privilegedKeys[#output.privilegedKeys + 1] = safeKeyName(key)
        end
        if inputByName[normalized] and type(value) == "function" and not inputSeen[normalized] then
          inputSeen[normalized] = true
          local sameFunction = value == inputByName[normalized].fn
          output.inputBindings[#output.inputBindings + 1] = { name = normalized, sameAsResolvedGlobal = sameFunction }
        end
      end
      if typeof(value) == "Instance" then
        for serviceName, service in pairs(services) do
          local kind = sameInstanceKind(value, service)
          if kind then
            output.serviceReferences[#output.serviceReferences + 1] = {
              key = type(key) == "string" and safeKeyName(key) or "<non-string-key>",
              service = serviceName,
              referenceKind = kind,
            }
            if targetScoped then
              report.virtualInput.targetReferences[#report.virtualInput.targetReferences + 1] = {
                origin = label,
                location = type(key) == "string" and safeKeyName(key) or "<non-string-key>",
                service = serviceName,
                referenceKind = kind,
              }
            end
            if targetScoped and (serviceName == "VirtualInputManager" or serviceName == "VirtualUser") and kind == "direct" then
              addFinding(
                "direct-virtual-service-env-" .. serviceName .. "-" .. tostring(output.environmentId),
                "virtual-input",
                "medium",
                "confirmed-local",
                true,
                "Target environment retains a direct " .. serviceName .. " reference",
                "Environment " .. tostring(output.environmentId) .. " exposes the raw service reference under a key name; no value was returned.",
                12
              )
            end
          end
        end
      end
    end
  end)
  table.sort(output.keys)
  table.sort(output.privilegedKeys)
  if not okIter then output.error = "environment enumeration failed: " .. text(iterError, 160) end
  if targetScoped and #output.privilegedKeys > 0 then
    addFinding(
      "target-environment-privileged-" .. tostring(output.environmentId),
      "environment",
      "medium",
      "heuristic",
      false,
      "Target environment exposes privileged executor-facing names",
      tostring(#output.privilegedKeys) .. " bounded key names were visible, including " .. table.concat(output.privilegedKeys, ", "),
      8
    )
  end
  if targetScoped and output.sameAsGetgenv then
    addFinding(
      "target-environment-is-getgenv-" .. tostring(output.environmentId),
      "environment",
      "medium",
      "confirmed-local",
      true,
      "Target environment is the executor global environment",
      "The target environment has direct table identity with getgenv(); only bounded key names were returned.",
      14
    )
  end
  return output
end

local scriptTarget = nil
if CONFIG.scriptExpression ~= "" then
  local value, err = evaluateExpression(CONFIG.scriptExpression, "Instance")
  if err then
    report.target.script = { resolved = false, error = err }
    addUnknown("script-target", err)
  else
    scriptTarget = value
    report.target.script = instanceInfo(value) or { resolved = true }
    report.target.script.resolved = true
    local okLuaSource, isLuaSource = pcall(function() return value:IsA("LuaSourceContainer") end)
    report.target.script.isLuaSourceContainer = okLuaSource and isLuaSource == true
    if not report.target.script.isLuaSourceContainer then addUnknown("script-target-type", "resolved Instance is not a LuaSourceContainer") end
  end
end

local explicitFunction = nil
if CONFIG.functionExpression ~= "" then
  local value, err = evaluateExpression(CONFIG.functionExpression, "function")
  if err then
    report.target.explicitFunction = { resolved = false, error = err }
    addUnknown("function-target", err)
  else
    explicitFunction = value
    report.target.explicitFunction = { resolved = true, info = functionInfo(value) }
  end
end

local scriptClosure = nil
if scriptTarget ~= nil then
  if type(F.getscripthash) == "function" then
    local ok, value = pcall(F.getscripthash, scriptTarget)
    if ok and value ~= nil then report.target.script.scriptHash = text(value, 180) else addUnknown("script-hash", "getscripthash failed") end
  else
    addUnknown("script-hash", "getscripthash unavailable")
  end
  if type(F.getsenv) == "function" then
    local ok, environment = pcall(F.getsenv, scriptTarget)
    if ok and type(environment) == "table" then
      report.environments.targetScript = inspectEnvironment("target-script-getsenv", environment, true)
    else
      addUnknown("script-environment", "getsenv failed or returned no table")
    end
  else
    addUnknown("script-environment", "getsenv unavailable")
  end
  if type(F.getscriptclosure) == "function" then
    local ok, closure = pcall(F.getscriptclosure, scriptTarget)
    if ok and type(closure) == "function" then scriptClosure = closure else addUnknown("script-closure", "getscriptclosure failed or returned no function") end
  else
    addUnknown("script-closure", "getscriptclosure unavailable")
  end
end

local selectedClosure = explicitFunction or scriptClosure
if selectedClosure ~= nil then
  report.target.selectedClosure = explicitFunction and "explicit-function" or "script-closure"
  report.closure = functionInfo(selectedClosure)
  if report.closure and report.closure.isFunctionHooked == true then
    addFinding(
      "target-function-hooked",
      "closure",
      "high",
      "confirmed-local",
      true,
      "The selected target closure reports as hooked",
      "isfunctionhooked returned true for the selected closure.",
      24
    )
  end
  if report.closure and report.closure.isExecutorClosure == true and report.closure.source and report.closure.source ~= "" then
    addFinding(
      "executor-closure-debug-identity",
      "closure",
      "low",
      "heuristic",
      false,
      "Executor closure identity is visible through debug metadata",
      "The selected closure is classified as executor-origin and exposes bounded source metadata.",
      5
    )
  end
else
  addUnknown("selected-closure", "no function target or readable script closure was available")
end

if type(F.getcallingscript) == "function" then
  local ok, caller = pcall(F.getcallingscript)
  if ok and typeof(caller) == "Instance" then
    report.target.currentCallingScript = instanceInfo(caller)
    if scriptTarget ~= nil then
      local relation = sameInstanceKind(caller, scriptTarget)
      report.target.currentCallingScriptRelation = relation
      if relation then
        addFinding(
          "current-caller-matches-target",
          "script-identity",
          "medium",
          "confirmed-local",
          true,
          "Current calling-script identity matches the selected target",
          "getcallingscript exposed a reference matching the target during the audit call.",
          10
        )
      end
    end
  elseif not ok then
    addUnknown("calling-script", "getcallingscript raised an error")
  else
    report.target.currentCallingScript = nil
  end
else
  addUnknown("calling-script", "getcallingscript unavailable")
end

local INDICATORS = {
  { id = "virtual-input-manager", category = "virtual-input", terms = { "virtualinputmanager", "virtualuser", "createvirtualinput" }, points = 12 },
  { id = "mouse-input", category = "virtual-input", terms = { "mouse1click", "mouse1press", "mouse1release", "mouse2click", "mouse2press", "mouse2release", "mousemoverel", "mousemoveabs", "mousescroll" }, points = 10 },
  { id = "keyboard-input", category = "virtual-input", terms = { "keypress", "keyrelease", "keyclick" }, points = 10 },
  { id = "environment-access", category = "environment", terms = { "getfenv", "setfenv", "getgenv", "getrenv", "getsenv", "shared" }, points = 6 },
  { id = "hooking", category = "closure", terms = { "hookfunction", "hookmetamethod", "restorefunction", "newcclosure", "setstackhidden" }, points = 10 },
  { id = "debug-reflection", category = "reflection", terms = { "getconstants", "getupvalues", "getprotos", "debug.get", "getgc" }, points = 6 },
  { id = "script-identity", category = "script-identity", terms = { "getcallingscript", "getscriptclosure", "getscripthash" }, points = 7 },
  { id = "executor-fingerprint", category = "environment", terms = { "identifyexecutor", "getexecutorname", "getexecutorinfo", "syn.", "fluxus", "krnl", "__mcp_", "gethui" }, points = 7 },
}

local function scanIndicatorText(origin, lineNumber, rawText, sink)
  local normalized = string.lower(rawText)
  for _, indicator in ipairs(INDICATORS) do
    for _, term in ipairs(indicator.terms) do
      if string.find(normalized, term, 1, true) then
        if evidenceCount < CONFIG.maxEvidence and #report.sourceIndicators < sourceEvidenceLimit then
          report.sourceIndicators[#report.sourceIndicators + 1] = {
            origin = origin,
            line = lineNumber,
            indicator = indicator.id,
            term = term,
            snippet = origin == "closure-constant" and "<redacted:matching-string-constant>" or redactSnippet(rawText),
          }
          evidenceCount = evidenceCount + 1
        else
          report.telemetry.truncation.evidence = true
        end
        if inputByName[term] then usedInputNames[term] = true end
        if term == "virtualinputmanager" or term == "virtualuser" or term == "createvirtualinput" then
          usedInputNames.__virtualService = true
        end
        sink[indicator.id] = sink[indicator.id] or { indicator = indicator, terms = {} }
        sink[indicator.id].terms[term] = true
        break
      end
    end
  end
end

local indicatorEvidence = {}
if scriptTarget ~= nil and CONFIG.includeSourceScan then
  local ok, sourceText = pcall(function() return scriptTarget.Source end)
  if ok and type(sourceText) == "string" then
    local originalLength = #sourceText
    if originalLength > CONFIG.maxSourceChars then
      sourceText = string.sub(sourceText, 1, CONFIG.maxSourceChars)
      report.telemetry.truncation.source = true
    end
    report.telemetry.scanned.sourceChars = #sourceText
    report.target.script.sourceAccessible = true
    report.target.script.sourceLength = originalLength
    report.target.script.sourceScannedChars = #sourceText
    local lineNumber = 0
    for line in string.gmatch(sourceText .. "\\n", "([^\\r\\n]*)\\r?\\n") do
      lineNumber = lineNumber + 1
      report.telemetry.scanned.sourceLines = lineNumber
      scanIndicatorText("script-source", lineNumber, line, indicatorEvidence)
    end
  else
    if report.target.script then report.target.script.sourceAccessible = false end
    addUnknown("script-source", "script.Source was unavailable; the tool does not decompile as a fallback")
  end
elseif scriptTarget ~= nil then
  addUnknown("script-source", "source scan disabled by input")
end

local constantSummary = { scanned = 0, types = {}, indicators = {}, truncated = false }
if selectedClosure ~= nil and CONFIG.maxConstants > 0 then
  if type(F.getconstants) == "function" then
    local ok, constants = pcall(F.getconstants, selectedClosure)
    if ok and type(constants) == "table" then
      local seen = 0
      for _, value in pairs(constants) do
        if seen >= CONFIG.maxConstants then
          constantSummary.truncated = true
          report.telemetry.truncation.constants = true
          break
        end
        seen = seen + 1
        constantSummary.scanned = seen
        report.telemetry.scanned.constants = seen
        local valueType = typeof(value)
        constantSummary.types[valueType] = (constantSummary.types[valueType] or 0) + 1
        if type(value) == "string" then scanIndicatorText("closure-constant", nil, value, indicatorEvidence) end
      end
    else
      addUnknown("closure-constants", "getconstants failed or returned no table")
    end
  else
    addUnknown("closure-constants", "getconstants/debug.getconstants unavailable")
  end
end
if report.closure then report.closure.constantSummary = constantSummary end

local upvalueSummary = { scanned = 0, entries = {}, serviceReferences = {}, truncated = false }
if selectedClosure ~= nil and CONFIG.maxUpvalues > 0 then
  if type(F.getupvalues) == "function" then
    local ok, upvalues = pcall(F.getupvalues, selectedClosure)
    if ok and type(upvalues) == "table" then
      local scanned = 0
      for key, value in pairs(upvalues) do
        if scanned >= CONFIG.maxUpvalues then
          upvalueSummary.truncated = true
          report.telemetry.truncation.upvalues = true
          break
        end
        scanned = scanned + 1
        report.telemetry.scanned.upvalues = scanned
        local entry = {
          index = type(key) == "number" and key or nil,
          name = type(key) == "string" and safeKeyName(key) or nil,
          valueType = typeof(value),
        }
        if type(key) == "string" and inputByName[string.lower(key)] then usedInputNames[string.lower(key)] = true end
        if typeof(value) == "Instance" then
          for serviceName, service in pairs(services) do
            local kind = sameInstanceKind(value, service)
            if kind then
              local reference = {
                location = entry.name or ("upvalue-" .. tostring(scanned)),
                service = serviceName,
                referenceKind = kind,
              }
              entry.serviceReference = reference
              upvalueSummary.serviceReferences[#upvalueSummary.serviceReferences + 1] = reference
              report.virtualInput.targetReferences[#report.virtualInput.targetReferences + 1] = {
                origin = "target-closure-upvalue",
                location = reference.location,
                service = serviceName,
                referenceKind = kind,
              }
              if (serviceName == "VirtualInputManager" or serviceName == "VirtualUser") and kind == "direct" then
                addFinding(
                  "direct-virtual-service-upvalue-" .. serviceName .. "-" .. tostring(scanned),
                  "virtual-input",
                  "medium",
                  "confirmed-local",
                  true,
                  "Target closure captures a direct " .. serviceName .. " reference",
                  "A bounded upvalue classification matched the raw service reference; the captured value was not returned.",
                  14
                )
              end
            end
          end
        end
        upvalueSummary.entries[#upvalueSummary.entries + 1] = entry
      end
      upvalueSummary.scanned = scanned
    else
      addUnknown("closure-upvalues", "getupvalues failed or returned no table")
    end
  else
    addUnknown("closure-upvalues", "getupvalues/debug.getupvalues unavailable")
  end
end
if report.closure then report.closure.upvalueSummary = upvalueSummary end

if selectedClosure ~= nil and type(F.getfenv) == "function" then
  report.telemetry.getfenvUsed = true
  local ok, environment = pcall(F.getfenv, selectedClosure)
  if ok and type(environment) == "table" then
    report.environments.targetFunction = inspectEnvironment("target-function-getfenv", environment, true)
  else
    addUnknown("function-environment", "getfenv(target) failed or returned no table")
  end
elseif selectedClosure ~= nil then
  addUnknown("function-environment", "getfenv unavailable")
end

if report.environments.targetScript and report.environments.targetFunction then
  report.environments.targetRelation = {
    sameEnvironment = report.environments.targetScript.environmentId == report.environments.targetFunction.environmentId,
    scriptEnvironmentId = report.environments.targetScript.environmentId,
    functionEnvironmentId = report.environments.targetFunction.environmentId,
  }
end

if CONFIG.includeStackEnvironments then
  if type(F.getfenv) == "function" then
    report.telemetry.getfenvUsed = true
    local unique = {}
    local previousId = nil
    local reuseCount = 0
    for level = 0, CONFIG.maxStackFrames - 1 do
      local ok, environment = pcall(F.getfenv, level)
      report.telemetry.scanned.stackFrames = report.telemetry.scanned.stackFrames + 1
      if ok and type(environment) == "table" then
        local id = environmentId(environment)
        local reused = unique[id] == true
        if reused then reuseCount = reuseCount + 1 end
        report.environments.currentStack[#report.environments.currentStack + 1] = {
          level = level,
          accessible = true,
          environmentId = id,
          sameAsPrevious = previousId == id,
          reusedAcrossFrames = reused,
        }
        if not unique[id] then
          unique[id] = true
          report.environments.uniqueCurrent[#report.environments.uniqueCurrent + 1] = inspectEnvironment("current-stack-level-" .. tostring(level), environment, false)
        end
        previousId = id
      else
        report.environments.currentStack[#report.environments.currentStack + 1] = { level = level, accessible = false }
        if level > 1 then break end
      end
    end
    report.environments.currentStackReuseCount = reuseCount
  else
    addUnknown("stack-environments", "getfenv unavailable")
  end
end

if report.telemetry.getfenvUsed then
  report.notes[#report.notes + 1] = "Luau deprecates getfenv/setfenv; getfenv reads can deoptimize the inspected environment."
end

for indicatorId, record in pairs(indicatorEvidence) do
  local terms = {}
  for term in pairs(record.terms) do terms[#terms + 1] = term end
  table.sort(terms)
  addFinding(
    "target-indicator-" .. indicatorId,
    record.indicator.category,
    record.indicator.category == "virtual-input" and "medium" or "low",
    "heuristic",
    false,
    "Target material contains " .. indicatorId .. " indicators",
    "Bounded source/constant inspection matched: " .. table.concat(terms, ", "),
    record.indicator.points
  )
end

for inputName in pairs(usedInputNames) do
  if inputName ~= "__virtualService" then
    local input = inputByName[inputName]
    local retained = input and input.report and input.report.retainedReference or nil
    if retained and retained.available == true and retained.matched ~= true then
      addFinding(
        "input-provenance-no-retained-match-" .. inputName,
        "virtual-input",
        "low",
        "heuristic",
        false,
        "Used input primitive has no retained MCP closure match",
        inputName .. " was referenced by target evidence, but no bounded identity/hash match was found. This is provenance only; cloning is not a safety recommendation.",
        4
      )
    elseif retained and retained.available ~= true then
      addUnknown("input-retained-reference-" .. inputName, "retained MCP closure registry unavailable; provenance match is unknown")
    end
  end
end

local availableCapabilityCount = 0
local totalCapabilityCount = 0
for _, entry in pairs(report.capabilities) do
  totalCapabilityCount = totalCapabilityCount + 1
  if entry.available == true then availableCapabilityCount = availableCapabilityCount + 1 end
end
local coverage = totalCapabilityCount > 0 and (availableCapabilityCount / totalCapabilityCount) or 0
local score = math.min(100, riskPoints)
local band = "minimal"
if score >= 75 then band = "severe"
elseif score >= 50 then band = "high"
elseif score >= 25 then band = "moderate"
elseif score >= 10 then band = "low" end
local confidence = "low"
if confirmedFindingCount > 0 and coverage >= 0.7 then confidence = "high"
elseif confirmedFindingCount > 0 or coverage >= 0.5 then confidence = "medium" end

report.risk = {
  score = score,
  band = band,
  confidence = confidence,
  confirmedFindings = confirmedFindingCount,
  heuristicFindings = heuristicFindingCount,
  capabilityCoverage = math.floor(coverage * 1000 + 0.5) / 1000,
  interpretation = "Local observable exposure only; not a detection verdict.",
}

report.telemetry.findingCount = #report.findings
report.telemetry.evidenceCount = evidenceCount
report.telemetry.unknownCheckCount = #report.unknownChecks
report.telemetry.sourceIndicatorCount = #report.sourceIndicators
report.telemetry.durationMs = math.max(0, math.floor((now() - startedAt) * 1000 + 0.5))
report.telemetry.truncated = report.telemetry.truncation.evidence
  or report.telemetry.truncation.environments
  or report.telemetry.truncation.source
  or report.telemetry.truncation.constants
  or report.telemetry.truncation.upvalues
  or report.telemetry.truncation.retainedRefs
  or report.telemetry.truncation.unknownChecks
report.ok = true
return report
`;

    const data = (await ctx.runLuau(source, {
      threadContext,
      timeoutMs: 30000,
    })) as {
      risk?: { score?: number; band?: string; confidence?: string };
    };

    const risk = data?.risk;
    return {
      data,
      summary: risk
        ? `Local exposure risk ${risk.score ?? "?"}/100 (${risk.band ?? "unknown"}, ${risk.confidence ?? "unknown"} confidence); not a detection verdict.`
        : "Execution-footprint audit completed; inspect the structured report.",
    };
  },
});
