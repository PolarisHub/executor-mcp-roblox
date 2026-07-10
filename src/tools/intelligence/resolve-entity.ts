import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

const RESOLUTION_ROOTS = ["workspace", "playerGui", "backpack", "character"] as const;

function luaList(values: readonly string[]): string {
  return "{ " + values.map((value) => q(value)).join(", ") + " }";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolutionSummary(handle: string, data: unknown): string {
  const result = record(data);
  if (!result) return "Entity resolution completed for " + handle + ".";
  const status = typeof result["status"] === "string" ? result["status"] : "unknown";
  const path = typeof result["path"] === "string" ? result["path"] : undefined;
  const confidence =
    typeof result["confidence"] === "number"
      ? " at confidence " + result["confidence"].toFixed(2)
      : "";
  if (path) return "Entity " + handle + " is " + status + " at " + path + confidence + ".";
  return "Entity " + handle + " is " + status + confidence + "; no live path was resolved.";
}

export default defineTool({
  name: "resolve-entity",
  title: "Resolve or rediscover a semantic world handle",
  description:
    "Resolve a session-local handle returned by observe-world back to its live Roblox Instance. A live weak " +
    "reference resolves immediately. If it is stale or destroyed, optional bounded rediscovery scores candidates " +
    "against the stored structural fingerprint (class, name, parent, grandparent, original path, and root) and " +
    "reattaches the same handle when confidence clears the requested threshold. Returns an exact path and executable " +
    "bracket-safe expression, class, confidence, staleness state, match evidence, runner-up ambiguity, scan counts, " +
    "and truncation. Read-only; uses GetChildren with a hard cap and never performs GetDescendants or a frame loop.",
  category: "Intelligence",
  mutatesState: false,
  ai: {
    phase: "verify",
    prerequisites: ["active-client", "semantic handle previously returned by observe-world"],
    consumes: ["semantic-entity-handle", "optional rediscovery scope"],
    produces: [
      "live-instance-path",
      "actionable-instance-expression",
      "staleness-status",
      "structural-match-confidence",
      "resolution-evidence",
    ],
    verifiesWith: [],
    alternatives: ["observe-world", "search-instances", "verify-path-exists"],
    requiresCapabilities: [],
    sideEffects: [],
    failureRecovery: [
      "If status is unknown-handle or brain-unavailable, call observe-world in the same MCP session.",
      "If status is stale, widen roots or maxInstances and retry rediscovery once.",
      "If evidence reports ambiguity, call observe-world with a narrower root or use search-instances before acting.",
      "Use expression rather than path for follow-up tools when names contain punctuation or spaces.",
    ],
  },
  input: z.object({
    handle: z
      .string()
      .min(1)
      .max(200)
      .describe("Session-local entity handle returned by observe-world, for example 'wb:12'."),
    rediscover: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "When true, a stale weak reference triggers bounded structural rediscovery. False only reports staleness.",
      ),
    roots: z
      .array(z.enum(RESOLUTION_ROOTS))
      .min(1)
      .max(RESOLUTION_ROOTS.length)
      .optional()
      .default(["workspace", "playerGui", "backpack", "character"])
      .describe("Roots searched when rediscovering a stale handle."),
    maxInstances: z
      .number()
      .int()
      .positive()
      .max(10000)
      .optional()
      .default(2500)
      .describe("Hard maximum number of unique instances examined during rediscovery."),
    minConfidence: z
      .number()
      .finite()
      .min(0)
      .max(1)
      .optional()
      .default(0.45)
      .describe(
        "Minimum adjusted fingerprint confidence required to reattach a stale handle. Ambiguous runner-up matches " +
          "reduce confidence.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ handle, rediscover, roots, maxInstances, minConfidence, threadContext }, ctx) {
    const safeMaxInstances = Math.min(Math.max(Math.floor(maxInstances), 1), 10000);
    const safeMinConfidence = Math.min(Math.max(minConfidence, 0), 1);
    const sessionKey = String(ctx.session.id);

    const source = `
local HANDLE = ${q(handle)}
local SESSION_KEY = ${q(sessionKey)}
local REDISCOVER = ${rediscover ? "true" : "false"}
local MAX_INSTANCES = ${safeMaxInstances}
local MIN_CONFIDENCE = ${safeMinConfidence}
local ROOT_LIST = ${luaList([...new Set(roots)])}
local NOW = os.clock()

local function safeService(name)
  local ok, value = pcall(function() return game:GetService(name) end)
  if ok and typeof(value) == "Instance" then return value end
  return nil
end

local function safeName(instance)
  local ok, value = pcall(function() return instance.Name end)
  return ok and tostring(value) or "<unknown>"
end

local function safeClass(instance)
  local ok, value = pcall(function() return instance.ClassName end)
  return ok and tostring(value) or "<unknown>"
end

local function safeParent(instance)
  local ok, value = pcall(function() return instance.Parent end)
  return ok and value or nil
end

local function pathOf(instance)
  local ok, value = pcall(function() return instance:GetFullName() end)
  return ok and tostring(value) or tostring(instance)
end

local function quoted(value)
  local ok, encoded = pcall(string.format, "%q", tostring(value))
  return ok and encoded or [["<unquotable>"]]
end

local function expressionOf(instance)
  if instance == game then return "game" end
  local chain = {}
  local current = instance
  for _ = 1, 128 do
    if current == nil or current == game then break end
    chain[#chain + 1] = current
    current = safeParent(current)
  end
  if current ~= game or #chain == 0 then return nil end

  local top = chain[#chain]
  local topClass = safeClass(top)
  local expression = nil
  local okService, service = pcall(function() return game:GetService(topClass) end)
  if okService and service == top then
    expression = "game:GetService(" .. quoted(topClass) .. ")"
  else
    expression = "game[" .. quoted(safeName(top)) .. "]"
  end
  for index = #chain - 1, 1, -1 do
    expression = expression .. "[" .. quoted(safeName(chain[index])) .. "]"
  end
  return expression
end

local function fingerprintOf(instance, rootLabel)
  local parent = safeParent(instance)
  local grandparent = parent and safeParent(parent) or nil
  local className = safeClass(instance)
  local name = safeName(instance)
  local parentClass = parent and safeClass(parent) or nil
  local parentName = parent and safeName(parent) or nil
  local grandparentClass = grandparent and safeClass(grandparent) or nil
  local grandparentName = grandparent and safeName(grandparent) or nil
  return {
    class = className,
    name = name,
    parentClass = parentClass,
    parentName = parentName,
    grandparentClass = grandparentClass,
    grandparentName = grandparentName,
    root = rootLabel,
    path = pathOf(instance),
    expression = expressionOf(instance),
    signature = table.concat({
      className,
      name,
      tostring(parentClass),
      tostring(parentName),
      tostring(grandparentClass),
      tostring(grandparentName),
    }, "|"),
  }
end

local function liveInstance(value)
  if typeof(value) ~= "Instance" then return false end
  if value == game then return true end
  local ok, parent = pcall(function() return value.Parent end)
  return ok and parent ~= nil
end

local function getBrain()
  if type(getgenv) ~= "function" then
    return nil, "getgenv is unavailable."
  end
  local okEnv, env = pcall(getgenv)
  if not okEnv or type(env) ~= "table" then
    return nil, "getgenv did not return a table."
  end
  local store = env.__mcp_world_brain
  if type(store) ~= "table" or store.version ~= 1 or type(store.sessions) ~= "table" then
    return nil, "No world brain exists. Run observe-world in this session first."
  end
  local brain = store.sessions[SESSION_KEY]
  if type(brain) ~= "table" or type(brain.meta) ~= "table" or type(brain.refs) ~= "table" then
    return nil, "No world brain exists for this MCP session. Run observe-world first."
  end
  if type(brain.reverse) ~= "table" then brain.reverse = {} end
  brain.lastTouched = NOW
  return brain, nil
end

local brain, brainError = getBrain()
if brain == nil then
  return {
    ok = false,
    status = "brain-unavailable",
    handle = HANDLE,
    stale = true,
    confidence = 0,
    path = nil,
    class = nil,
    evidence = { reason = brainError },
    scanned = { instances = 0, roots = 0 },
    truncated = false,
  }
end

local metadata = brain.meta[HANDLE]
if type(metadata) ~= "table" or type(metadata.fingerprint) ~= "table" then
  return {
    ok = false,
    status = "unknown-handle",
    handle = HANDLE,
    stale = true,
    confidence = 0,
    path = nil,
    class = nil,
    evidence = { reason = "The handle is not registered in this MCP session." },
    scanned = { instances = 0, roots = 0 },
    truncated = false,
  }
end

local stored = metadata.fingerprint
local referenced = brain.refs[HANDLE]
if liveInstance(referenced) then
  local current = fingerprintOf(referenced, stored.root)
  metadata.fingerprint = current
  metadata.lastSeen = NOW
  metadata.confidence = 1
  brain.refs[HANDLE] = referenced
  brain.reverse[referenced] = HANDLE
  return {
    ok = true,
    status = "resolved-live",
    handle = HANDLE,
    stale = false,
    rediscovered = false,
    path = current.path,
    expression = current.expression,
    class = current.class,
    name = current.name,
    confidence = 1,
    evidence = {
      weakReference = "live",
      pathChanged = stored.path ~= current.path,
      previousPath = stored.path,
      fingerprint = current.signature,
    },
    scanned = { instances = 0, roots = 0 },
    truncated = false,
  }
end

if not REDISCOVER then
  return {
    ok = false,
    status = "stale",
    handle = HANDLE,
    stale = true,
    rediscovered = false,
    path = stored.path,
    expression = stored.expression,
    class = stored.class,
    name = stored.name,
    confidence = 0,
    evidence = {
      reason = "The weak reference is gone or destroyed and rediscovery was disabled.",
      fingerprint = stored.signature,
      lastSeen = metadata.lastSeen,
    },
    scanned = { instances = 0, roots = 0 },
    truncated = false,
  }
end

local Players = safeService("Players")
local Workspace = safeService("Workspace")
local localPlayer = nil
if Players then pcall(function() localPlayer = Players.LocalPlayer end) end
local character = nil
local playerGui = nil
local backpack = nil
if localPlayer then
  pcall(function() character = localPlayer.Character end)
  pcall(function() playerGui = localPlayer:FindFirstChildOfClass("PlayerGui") end)
  pcall(function() backpack = localPlayer:FindFirstChildOfClass("Backpack") end)
end

local requestedRoots = {}
for _, name in ipairs(ROOT_LIST) do requestedRoots[name] = true end
local queue = {}
local rootSeen = setmetatable({}, { __mode = "k" })
local function addRoot(instance, label)
  if instance == nil or rootSeen[instance] then return end
  rootSeen[instance] = true
  queue[#queue + 1] = { instance = instance, root = label }
end
if requestedRoots.workspace then addRoot(Workspace, "workspace") end
if requestedRoots.playerGui then addRoot(playerGui, "playerGui") end
if requestedRoots.backpack then addRoot(backpack, "backpack") end
if requestedRoots.character then addRoot(character, "character") end

local function addReason(reasons, condition, label)
  if condition then reasons[#reasons + 1] = label end
end

local function scoreCandidate(instance, rootLabel)
  local className = safeClass(instance)
  if stored.class ~= nil and className ~= stored.class then return 0, {} end

  local parent = safeParent(instance)
  local grandparent = parent and safeParent(parent) or nil
  local name = safeName(instance)
  local parentClass = parent and safeClass(parent) or nil
  local parentName = parent and safeName(parent) or nil
  local grandparentClass = grandparent and safeClass(grandparent) or nil
  local grandparentName = grandparent and safeName(grandparent) or nil
  local path = pathOf(instance)
  local score = stored.class == className and 0.24 or 0
  local reasons = {}
  addReason(reasons, stored.class == className, "class")
  if stored.name == name then score = score + 0.25; reasons[#reasons + 1] = "name" end
  if stored.parentClass == parentClass then score = score + 0.08; reasons[#reasons + 1] = "parent-class" end
  if stored.parentName == parentName then score = score + 0.12; reasons[#reasons + 1] = "parent-name" end
  if stored.grandparentClass == grandparentClass then score = score + 0.05; reasons[#reasons + 1] = "grandparent-class" end
  if stored.grandparentName == grandparentName then score = score + 0.08; reasons[#reasons + 1] = "grandparent-name" end
  if stored.root == rootLabel then score = score + 0.05; reasons[#reasons + 1] = "root" end
  if stored.path == path then score = 1; reasons[#reasons + 1] = "exact-path" end
  return math.min(score, 1), reasons
end

local best = nil
local second = nil
local seen = setmetatable({}, { __mode = "k" })
local scanned = 0
local head = 1
local queueTruncated = false
while head <= #queue and scanned < MAX_INSTANCES do
  local entry = queue[head]
  head = head + 1
  local instance = entry.instance
  if instance ~= nil and not seen[instance] then
    seen[instance] = true
    scanned = scanned + 1
    local score, reasons = scoreCandidate(instance, entry.root)
    if score > 0 then
      local candidate = {
        instance = instance,
        root = entry.root,
        score = score,
        reasons = reasons,
      }
      if best == nil or score > best.score then
        second = best
        best = candidate
      elseif second == nil or score > second.score then
        second = candidate
      end
    end

    local okChildren, children = pcall(function() return instance:GetChildren() end)
    if okChildren and type(children) == "table" then
      for _, child in ipairs(children) do
        if #queue >= MAX_INSTANCES then
          queueTruncated = true
          break
        end
        queue[#queue + 1] = { instance = child, root = entry.root }
      end
    end
  end
end
if head <= #queue then queueTruncated = true end

local rawConfidence = best and best.score or 0
local runnerUpConfidence = second and second.score or 0
local margin = rawConfidence - runnerUpConfidence
local adjustedConfidence = rawConfidence
local ambiguous = second ~= nil and margin < 0.08
if ambiguous then adjustedConfidence = adjustedConfidence * 0.72 end

if best and adjustedConfidence >= MIN_CONFIDENCE then
  local current = fingerprintOf(best.instance, best.root)
  brain.refs[HANDLE] = best.instance
  brain.reverse[best.instance] = HANDLE
  metadata.fingerprint = current
  metadata.lastSeen = NOW
  metadata.confidence = adjustedConfidence
  return {
    ok = true,
    status = "rediscovered",
    handle = HANDLE,
    stale = false,
    rediscovered = true,
    path = current.path,
    expression = current.expression,
    class = current.class,
    name = current.name,
    confidence = adjustedConfidence,
    evidence = {
      matched = best.reasons,
      previousPath = stored.path,
      fingerprint = current.signature,
      rawConfidence = rawConfidence,
      runnerUpConfidence = runnerUpConfidence,
      margin = margin,
      ambiguous = ambiguous,
    },
    scanned = { instances = scanned, roots = #ROOT_LIST },
    truncated = queueTruncated,
  }
end

local bestFingerprint = best and fingerprintOf(best.instance, best.root) or nil
return {
  ok = false,
  status = "stale",
  handle = HANDLE,
  stale = true,
  rediscovered = false,
  path = stored.path,
  expression = stored.expression,
  class = stored.class,
  name = stored.name,
  confidence = adjustedConfidence,
  evidence = {
    reason = best and "Best structural match did not clear minConfidence." or "No same-class candidate was found.",
    fingerprint = stored.signature,
    bestCandidate = bestFingerprint and {
      path = bestFingerprint.path,
      expression = bestFingerprint.expression,
      class = bestFingerprint.class,
      name = bestFingerprint.name,
    } or nil,
    matched = best and best.reasons or {},
    rawConfidence = rawConfidence,
    runnerUpConfidence = runnerUpConfidence,
    margin = margin,
    ambiguous = ambiguous,
    minConfidence = MIN_CONFIDENCE,
  },
  scanned = { instances = scanned, roots = #ROOT_LIST },
  truncated = queueTruncated,
}
`;

    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data, summary: resolutionSummary(handle, data) };
  },
});
