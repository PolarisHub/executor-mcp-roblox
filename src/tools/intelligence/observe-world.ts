import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

const WORLD_ROOTS = ["workspace", "playerGui", "backpack", "character"] as const;
const WORLD_FEATURES = ["character", "camera", "gui", "nearby", "interactables", "tools"] as const;

function luaList(values: readonly string[]): string {
  return "{ " + values.map((value) => q(value)).join(", ") + " }";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function observationSummary(data: unknown): string {
  const result = record(data);
  if (!result) return "World observation completed.";
  if (typeof result["error"] === "string") {
    return "World observation could not complete: " + result["error"];
  }

  const scanned = record(result["scanned"]);
  const returned = record(result["returned"]);
  const truncated = record(result["truncated"]);
  const character = record(result["character"]);
  const scannedCount = typeof scanned?.["instances"] === "number" ? scanned["instances"] : 0;
  const returnedCount = typeof returned?.["entities"] === "number" ? returned["entities"] : 0;
  const wasTruncated = truncated?.["instances"] === true || truncated?.["results"] === true;
  const characterStatus =
    typeof character?.["status"] === "string" ? character["status"] : "unknown";

  return (
    "Observed " +
    returnedCount +
    " semantic entities from " +
    scannedCount +
    " bounded instance reads; character=" +
    characterStatus +
    (wasTruncated ? "; output was truncated by caller limits." : ".")
  );
}

export default defineTool({
  name: "observe-world",
  title: "Observe the live world and build semantic entity handles",
  description:
    "Perform one bounded, read-only Luau observation that fuses the active or custom character rig, current camera, " +
    "visible PlayerGui objects, nearby 3D parts, ClickDetectors, ProximityPrompts, TouchTransmitters, and Tool " +
    "instances in the Backpack or character. It returns compact evidence, exact GetFullName paths plus executable " +
    "bracket-safe Luau expressions, screen position and distance where available, exact scanned/truncation counts, " +
    "and stable session-local handles. Handles are retained in getgenv().__mcp_world_brain using weak references " +
    "when supported and structural fingerprints for later resolve-entity calls. The walk uses GetChildren with hard " +
    "instance/result caps; it never starts frame loops or performs an unbounded GetDescendants scan.",
  category: "Intelligence",
  mutatesState: false,
  ai: {
    phase: "observe",
    prerequisites: ["active-client"],
    consumes: ["goal", "optional spatial scope", "optional feature selection"],
    produces: [
      "bounded-world-model",
      "semantic-entity-handles",
      "actionable-instance-expressions",
      "custom-character-resolution",
      "camera-state",
      "visible-gui",
      "nearby-3d-entities",
      "interaction-targets",
      "inventory-tools",
    ],
    verifiesWith: ["resolve-entity"],
    alternatives: [
      "discover-character",
      "search-instances",
      "list-gui-elements",
      "get-instance-tree",
    ],
    requiresCapabilities: [],
    sideEffects: [],
    failureRecovery: [
      "If handle storage is unavailable, use each entity.expression directly.",
      "If character.status is missing, inspect character.reason and widen roots to include workspace and character.",
      "If truncated.instances is true, narrow roots or radius before increasing maxInstances.",
      "Resolve a handle immediately before a mutating action when the world may have changed.",
    ],
  },
  input: z.object({
    radius: z
      .number()
      .finite()
      .positive()
      .max(10000)
      .optional()
      .default(250)
      .describe(
        "Maximum distance in studs for nearby 3D objects and interactables. Distance uses the resolved character " +
          "root, then the character pivot, then the camera position.",
      ),
    roots: z
      .array(z.enum(WORLD_ROOTS))
      .min(1)
      .max(WORLD_ROOTS.length)
      .optional()
      .default(["workspace", "playerGui", "backpack", "character"])
      .describe(
        "Bounded traversal roots. Omit a root to avoid scanning that domain; custom rigs generally require workspace.",
      ),
    features: z
      .array(z.enum(WORLD_FEATURES))
      .min(1)
      .max(WORLD_FEATURES.length)
      .optional()
      .default(["character", "camera", "gui", "nearby", "interactables", "tools"])
      .describe(
        "Observation features to include. Character and camera probes are cheap; GUI, nearby, interactables, and " +
          "tools are collected only from the selected bounded roots.",
      ),
    maxInstances: z
      .number()
      .int()
      .positive()
      .max(10000)
      .optional()
      .default(2500)
      .describe("Hard maximum number of unique Instances examined across all selected roots."),
    maxResults: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .default(250)
      .describe(
        "Maximum ranked semantic entities returned. Exact candidate counts and result truncation are still reported.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ radius, roots, features, maxInstances, maxResults, threadContext }, ctx) {
    const safeRadius = Math.min(Math.max(radius, 1), 10000);
    const safeMaxInstances = Math.min(Math.max(Math.floor(maxInstances), 1), 10000);
    const safeMaxResults = Math.min(Math.max(Math.floor(maxResults), 1), 1000);
    const sessionKey = String(ctx.session.id);

    const source = `
local RADIUS = ${safeRadius}
local MAX_INSTANCES = ${safeMaxInstances}
local MAX_RESULTS = ${safeMaxResults}
local SESSION_KEY = ${q(sessionKey)}
local ROOT_LIST = ${luaList([...new Set(roots)])}
local FEATURE_LIST = ${luaList([...new Set(features)])}
local NOW = os.clock()

local ROOTS = {}
for _, name in ipairs(ROOT_LIST) do ROOTS[name] = true end
local FEATURES = {}
for _, name in ipairs(FEATURE_LIST) do FEATURES[name] = true end

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

-- Produces an expression that remains valid for names containing spaces, dots,
-- quotes, or Lua keywords. This is the path follow-up tools should consume.
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

local function isA(instance, className)
  local ok, value = pcall(function() return instance:IsA(className) end)
  return ok and value == true
end

local function numberProperty(instance, property)
  local ok, value = pcall(function() return instance[property] end)
  return ok and type(value) == "number" and value or nil
end

local function stringProperty(instance, property)
  local ok, value = pcall(function() return instance[property] end)
  return ok and type(value) == "string" and value or nil
end

local function booleanProperty(instance, property)
  local ok, value = pcall(function() return instance[property] end)
  return ok and type(value) == "boolean" and value or nil
end

local function vector3(value)
  if typeof(value) ~= "Vector3" then return nil end
  return {
    x = math.floor(value.X * 100 + 0.5) / 100,
    y = math.floor(value.Y * 100 + 0.5) / 100,
    z = math.floor(value.Z * 100 + 0.5) / 100,
  }
end

local function vector2(value)
  if typeof(value) ~= "Vector2" then return nil end
  return {
    x = math.floor(value.X * 100 + 0.5) / 100,
    y = math.floor(value.Y * 100 + 0.5) / 100,
  }
end

local function ancestorModel(instance)
  local current = instance
  for _ = 1, 12 do
    if current == nil then return nil end
    if isA(current, "Model") then return current end
    current = safeParent(current)
  end
  return nil
end

local function ancestorBasePart(instance)
  local current = instance
  for _ = 1, 12 do
    if current == nil then return nil end
    if isA(current, "BasePart") then return current end
    current = safeParent(current)
  end
  return nil
end

local function positionOf(instance)
  if instance == nil then return nil end
  if isA(instance, "BasePart") then
    local ok, value = pcall(function() return instance.Position end)
    if ok and typeof(value) == "Vector3" then return value end
  end
  if isA(instance, "Attachment") then
    local ok, value = pcall(function() return instance.WorldPosition end)
    if ok and typeof(value) == "Vector3" then return value end
  end
  if isA(instance, "Model") then
    local ok, value = pcall(function() return instance:GetPivot().Position end)
    if ok and typeof(value) == "Vector3" then return value end
  end
  local part = ancestorBasePart(instance)
  if part and part ~= instance then return positionOf(part) end
  return nil
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
  local path = pathOf(instance)
  local expression = expressionOf(instance)
  return {
    class = className,
    name = name,
    parentClass = parentClass,
    parentName = parentName,
    grandparentClass = grandparentClass,
    grandparentName = grandparentName,
    root = rootLabel,
    path = path,
    expression = expression,
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

local function ensureBrain()
  if type(getgenv) ~= "function" then
    return nil, "getgenv is unavailable; semantic handles are disabled."
  end
  local okEnv, env = pcall(getgenv)
  if not okEnv or type(env) ~= "table" then
    return nil, "getgenv did not return a writable table; semantic handles are disabled."
  end

  local store = env.__mcp_world_brain
  if type(store) ~= "table" or store.version ~= 1 then
    store = { version = 1, sessions = {} }
    env.__mcp_world_brain = store
  end
  if type(store.sessions) ~= "table" then store.sessions = {} end

  -- Expire other inactive MCP sessions so getgenv never grows forever.
  for key, session in pairs(store.sessions) do
    if key ~= SESSION_KEY and type(session) == "table" then
      local lastTouched = tonumber(session.lastTouched) or NOW
      if NOW - lastTouched > 3600 then store.sessions[key] = nil end
    end
  end

  local brain = store.sessions[SESSION_KEY]
  if type(brain) ~= "table" then
    brain = {
      nextId = 0,
      refs = {},
      reverse = {},
      meta = {},
      createdAt = NOW,
    }
    store.sessions[SESSION_KEY] = brain
  end
  if type(brain.refs) ~= "table" then brain.refs = {} end
  if type(brain.reverse) ~= "table" then brain.reverse = {} end
  if type(brain.meta) ~= "table" then brain.meta = {} end

  local weakValues = pcall(function() setmetatable(brain.refs, { __mode = "v" }) end)
  local weakKeys = pcall(function() setmetatable(brain.reverse, { __mode = "k" }) end)
  brain.weakReferences = weakValues and weakKeys
  brain.lastTouched = NOW

  -- Keep fingerprints briefly after an Instance dies so resolve-entity can
  -- rediscover replacements, then prune old stale metadata safely.
  local stale = {}
  for handle, meta in pairs(brain.meta) do
    if brain.refs[handle] == nil then
      local lastSeen = type(meta) == "table" and tonumber(meta.lastSeen) or 0
      if NOW - lastSeen > 900 then
        stale[#stale + 1] = { handle = handle, lastSeen = lastSeen }
      end
    end
  end
  table.sort(stale, function(a, b) return a.lastSeen < b.lastSeen end)
  for _, entry in ipairs(stale) do
    brain.meta[entry.handle] = nil
    brain.refs[entry.handle] = nil
  end
  return brain, nil
end

local brain, brainError = ensureBrain()

local function registerHandle(instance, rootLabel, confidence)
  if brain == nil or instance == nil then return nil, fingerprintOf(instance, rootLabel) end
  local handle = brain.reverse[instance]
  if type(handle) ~= "string" or type(brain.meta[handle]) ~= "table" then
    brain.nextId = (tonumber(brain.nextId) or 0) + 1
    handle = "wb:" .. tostring(brain.nextId)
  end
  local fingerprint = fingerprintOf(instance, rootLabel)
  brain.refs[handle] = instance
  brain.reverse[instance] = handle
  brain.meta[handle] = {
    fingerprint = fingerprint,
    confidence = confidence,
    firstSeen = brain.meta[handle] and brain.meta[handle].firstSeen or NOW,
    lastSeen = NOW,
  }
  return handle, fingerprint
end

local Players = safeService("Players")
local Workspace = safeService("Workspace")
local localPlayer = nil
if Players then pcall(function() localPlayer = Players.LocalPlayer end) end

local standardCharacter = nil
local playerGui = nil
local backpack = nil
if localPlayer then
  pcall(function() standardCharacter = localPlayer.Character end)
  pcall(function() playerGui = localPlayer:FindFirstChildOfClass("PlayerGui") end)
  pcall(function() backpack = localPlayer:FindFirstChildOfClass("Backpack") end)
end

local camera = nil
if Workspace then pcall(function() camera = Workspace.CurrentCamera end) end
local cameraSubject = nil
if camera then pcall(function() cameraSubject = camera.CameraSubject end) end
local cameraModel = cameraSubject and ancestorModel(cameraSubject) or nil

local missing = {}
local function missingValue(name, reason)
  missing[#missing + 1] = { name = name, reason = reason }
end
if not Players then missingValue("Players", "service unavailable") end
if not localPlayer then missingValue("LocalPlayer", "not available") end
if not Workspace then missingValue("Workspace", "service unavailable") end
if FEATURES.camera and not camera then missingValue("CurrentCamera", "not available") end
if FEATURES.gui and not playerGui then missingValue("PlayerGui", "not available") end
if FEATURES.tools and not backpack then missingValue("Backpack", "not available") end

local queue = {}
local queueRoots = setmetatable({}, { __mode = "k" })
local function addRoot(instance, label)
  if instance == nil or queueRoots[instance] then return end
  queueRoots[instance] = true
  queue[#queue + 1] = { instance = instance, root = label }
end
if ROOTS.workspace then addRoot(Workspace, "workspace") end
if ROOTS.playerGui then addRoot(playerGui, "playerGui") end
if ROOTS.backpack then addRoot(backpack, "backpack") end
if ROOTS.character then addRoot(standardCharacter, "character") end

local rigList = {}
local rigByModel = setmetatable({}, { __mode = "k" })
local function rigFor(model)
  if model == nil then return nil end
  local rig = rigByModel[model]
  if rig == nil then
    rig = { model = model }
    rigByModel[model] = rig
    rigList[#rigList + 1] = rig
  end
  return rig
end
if standardCharacter then rigFor(standardCharacter).standard = true end
if cameraModel then rigFor(cameraModel).cameraSubject = true end

local guiInstances = {}
local spatialInstances = {}
local interactableInstances = {}
local toolInstances = {}
local seenScan = setmetatable({}, { __mode = "k" })
local scannedByRoot = {}
local scanned = 0
local queueTruncated = false

local function rootLikeName(name)
  return name == "HumanoidRootPart" or name == "RootPart" or name == "LowerTorso" or name == "Torso"
end

local head = 1
while head <= #queue and scanned < MAX_INSTANCES do
  local entry = queue[head]
  head = head + 1
  local instance = entry.instance
  if instance ~= nil and not seenScan[instance] then
    seenScan[instance] = true
    scanned = scanned + 1
    scannedByRoot[entry.root] = (scannedByRoot[entry.root] or 0) + 1

    if isA(instance, "Model") then
      local name = safeName(instance)
      if instance == standardCharacter or instance == cameraModel or (localPlayer and name == safeName(localPlayer)) then
        rigFor(instance)
      end
    end

    if isA(instance, "Humanoid") then
      local model = ancestorModel(instance)
      local rig = rigFor(model)
      if rig then rig.humanoid = instance end
    elseif isA(instance, "BasePart") then
      spatialInstances[#spatialInstances + 1] = { instance = instance, root = entry.root }
      local model = ancestorModel(instance)
      local rig = rigByModel[model]
      local name = safeName(instance)
      if rig == nil and rootLikeName(name) then rig = rigFor(model) end
      if rig then
        if rig.firstPart == nil then rig.firstPart = instance end
        if rootLikeName(name) then rig.rootPart = instance end
        local okPrimary, primary = pcall(function() return model.PrimaryPart end)
        if okPrimary and primary == instance and rig.rootPart == nil then rig.primaryPart = instance end
      end
    end

    if FEATURES.gui and entry.root == "playerGui" and isA(instance, "GuiObject") then
      guiInstances[#guiInstances + 1] = { instance = instance, root = entry.root }
    end
    if FEATURES.interactables and (
      isA(instance, "ClickDetector") or
      isA(instance, "ProximityPrompt") or
      isA(instance, "TouchTransmitter")
    ) then
      interactableInstances[#interactableInstances + 1] = { instance = instance, root = entry.root }
    end
    if FEATURES.tools and isA(instance, "Tool") then
      toolInstances[#toolInstances + 1] = { instance = instance, root = entry.root }
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

local bestRig = nil
local bestRigScore = -1
for _, rig in ipairs(rigList) do
  if rig.rootPart == nil then rig.rootPart = rig.primaryPart or rig.firstPart end
  local score = 0
  if rig.standard then score = score + 100 end
  if rig.cameraSubject then score = score + 85 end
  if localPlayer and safeName(rig.model) == safeName(localPlayer) then score = score + 45 end
  if rig.humanoid then score = score + 35 end
  if rig.rootPart then score = score + 25 end
  if score > bestRigScore then
    bestRig = rig
    bestRigScore = score
  end
end

local characterModel = bestRig and bestRig.model or standardCharacter
local humanoid = bestRig and bestRig.humanoid or nil
local rootPart = bestRig and bestRig.rootPart or nil
local characterConfidence = 0
local characterSource = nil
if bestRig then
  if bestRig.standard then
    characterConfidence = (humanoid and rootPart) and 1 or 0.82
    characterSource = "Players.LocalPlayer.Character"
  elseif bestRig.cameraSubject then
    characterConfidence = (humanoid and rootPart) and 0.94 or 0.78
    characterSource = "CurrentCamera.CameraSubject"
  else
    characterConfidence = math.min(0.9, math.max(0.45, bestRigScore / 180))
    characterSource = "bounded structural rig search"
  end
end

local cameraPosition = nil
local cameraLookVector = nil
if camera then
  pcall(function()
    cameraPosition = camera.CFrame.Position
    cameraLookVector = camera.CFrame.LookVector
  end)
end
local origin = positionOf(rootPart) or positionOf(characterModel) or cameraPosition
local originSource = rootPart and "character-root" or (characterModel and "character-pivot" or (cameraPosition and "camera" or nil))

local function distanceFromOrigin(instance)
  if origin == nil then return nil end
  local position = positionOf(instance)
  if position == nil then return nil end
  return (position - origin).Magnitude
end

local function guiVisible(instance)
  local current = instance
  for _ = 1, 32 do
    if current == nil or current == playerGui then break end
    if isA(current, "GuiObject") then
      local visible = booleanProperty(current, "Visible")
      if visible == false then return false end
    elseif isA(current, "LayerCollector") then
      local enabled = booleanProperty(current, "Enabled")
      if enabled == false then return false end
    end
    current = safeParent(current)
  end
  return true
end

local function screenEvidence(instance)
  if isA(instance, "GuiObject") then
    local okPosition, absolutePosition = pcall(function() return instance.AbsolutePosition end)
    local okSize, absoluteSize = pcall(function() return instance.AbsoluteSize end)
    if okPosition and okSize and typeof(absolutePosition) == "Vector2" and typeof(absoluteSize) == "Vector2" then
      return {
        x = math.floor((absolutePosition.X + absoluteSize.X / 2) * 10 + 0.5) / 10,
        y = math.floor((absolutePosition.Y + absoluteSize.Y / 2) * 10 + 0.5) / 10,
        size = vector2(absoluteSize),
        onScreen = guiVisible(instance),
      }
    end
  elseif camera then
    local position = positionOf(instance)
    if position then
      local okProjection, projected, onScreen = pcall(function()
        local point, visible = camera:WorldToViewportPoint(position)
        return point, visible
      end)
      if okProjection and typeof(projected) == "Vector3" then
        return {
          x = math.floor(projected.X * 10 + 0.5) / 10,
          y = math.floor(projected.Y * 10 + 0.5) / 10,
          depth = math.floor(projected.Z * 100 + 0.5) / 100,
          onScreen = onScreen == true,
        }
      end
    end
  end
  return nil
end

local candidates = {}
local candidateByInstance = setmetatable({}, { __mode = "k" })
local roleCounts = {}
local function consider(instance, role, score, rootLabel, detail)
  if instance == nil then return end
  local candidate = candidateByInstance[instance]
  if candidate == nil then
    candidate = {
      instance = instance,
      roles = {},
      details = {},
      score = score,
      root = rootLabel,
    }
    candidateByInstance[instance] = candidate
    candidates[#candidates + 1] = candidate
  end
  if not candidate.roles[role] then
    candidate.roles[role] = true
    roleCounts[role] = (roleCounts[role] or 0) + 1
  end
  candidate.details[role] = detail
  if score > candidate.score then
    candidate.score = score
    candidate.root = rootLabel
  end
end

if FEATURES.camera and camera then
  consider(camera, "camera", 1000, "workspace", {
    fieldOfView = numberProperty(camera, "FieldOfView"),
    viewportSize = (function()
      local ok, value = pcall(function() return camera.ViewportSize end)
      return ok and vector2(value) or nil
    end)(),
    subjectPath = cameraSubject and pathOf(cameraSubject) or nil,
  })
end

if FEATURES.character and characterModel then
  consider(characterModel, "character", 990, "character", {
    source = characterSource,
    custom = characterModel ~= standardCharacter,
    complete = humanoid ~= nil and rootPart ~= nil,
  })
  if humanoid then
    consider(humanoid, "humanoid", 985, "character", {
      health = numberProperty(humanoid, "Health"),
      maxHealth = numberProperty(humanoid, "MaxHealth"),
    })
  end
  if rootPart then
    consider(rootPart, "character-root", 980, "character", {
      position = vector3(positionOf(rootPart)),
    })
  end
end

if FEATURES.gui then
  for _, entry in ipairs(guiInstances) do
    local instance = entry.instance
    if guiVisible(instance) then
      local detail = {
        text = stringProperty(instance, "Text"),
        active = booleanProperty(instance, "Active"),
        selectable = booleanProperty(instance, "Selectable"),
      }
      if isA(instance, "GuiButton") then
        detail.action = { tool = "click-button", input = { path = expressionOf(instance) } }
      elseif isA(instance, "TextBox") then
        detail.action = { tool = "type-text-box", input = { path = expressionOf(instance) } }
      end
      local priority = detail.action and 830 or (detail.text and 760 or 700)
      consider(instance, "visible-gui", priority, entry.root, detail)
    end
  end
end

if FEATURES.interactables then
  for _, entry in ipairs(interactableInstances) do
    local instance = entry.instance
    local distance = distanceFromOrigin(instance)
    if distance == nil or distance <= RADIUS then
      local detail = { distance = distance }
      if isA(instance, "ClickDetector") then
        detail.action = { tool = "fire-click-detector", input = { path = expressionOf(instance) } }
        detail.maxActivationDistance = numberProperty(instance, "MaxActivationDistance")
      elseif isA(instance, "ProximityPrompt") then
        detail.action = { tool = "fire-proximity-prompt", input = { path = expressionOf(instance) } }
        detail.actionText = stringProperty(instance, "ActionText")
        detail.objectText = stringProperty(instance, "ObjectText")
        detail.enabled = booleanProperty(instance, "Enabled")
        detail.holdDuration = numberProperty(instance, "HoldDuration")
        detail.maxActivationDistance = numberProperty(instance, "MaxActivationDistance")
      else
        detail.action = {
          tool = "script",
          note = "Resolve the handle, find a local character part, then use firetouchinterest if supported.",
        }
      end
      consider(instance, "interactable", 930 - math.min(distance or 0, RADIUS) / math.max(RADIUS, 1) * 40, entry.root, detail)
    end
  end
end

if FEATURES.tools then
  for _, entry in ipairs(toolInstances) do
    local instance = entry.instance
    local parent = safeParent(instance)
    consider(instance, "tool", 880, entry.root, {
      equipped = characterModel ~= nil and parent == characterModel,
      toolTip = stringProperty(instance, "ToolTip"),
      enabled = booleanProperty(instance, "Enabled"),
      canBeDropped = booleanProperty(instance, "CanBeDropped"),
    })
  end
end

if FEATURES.nearby then
  for _, entry in ipairs(spatialInstances) do
    local instance = entry.instance
    local distance = distanceFromOrigin(instance)
    if distance == nil or distance <= RADIUS then
      consider(instance, "nearby-3d", 600 - math.min(distance or 0, RADIUS) / math.max(RADIUS, 1) * 100, entry.root, {
        distance = distance,
        position = vector3(positionOf(instance)),
        anchored = booleanProperty(instance, "Anchored"),
        canCollide = booleanProperty(instance, "CanCollide"),
      })
    end
  end
end

table.sort(candidates, function(a, b)
  if a.score ~= b.score then return a.score > b.score end
  return pathOf(a.instance) < pathOf(b.instance)
end)

local function describe(instance, candidate, confidenceOverride)
  local roles = {}
  for role in pairs(candidate.roles or {}) do roles[#roles + 1] = role end
  table.sort(roles)
  local confidence = confidenceOverride or math.min(0.99, math.max(0.45, candidate.score / 1000))
  local handle, fingerprint = registerHandle(instance, candidate.root, confidence)
  local distance = distanceFromOrigin(instance)
  local screen = screenEvidence(instance)
  local visible = nil
  if isA(instance, "GuiObject") then
    visible = guiVisible(instance)
  elseif screen then
    visible = screen.onScreen
  end
  return {
    handle = handle,
    path = fingerprint.path,
    expression = fingerprint.expression,
    class = fingerprint.class,
    name = fingerprint.name,
    roles = roles,
    confidence = confidence,
    fingerprint = fingerprint.signature,
    distance = distance and math.floor(distance * 100 + 0.5) / 100 or nil,
    visible = visible,
    screenPosition = screen,
    evidence = {
      root = candidate.root,
      details = candidate.details,
    },
  }
end

local entities = {}
for index = 1, math.min(MAX_RESULTS, #candidates) do
  entities[index] = describe(candidates[index].instance, candidates[index], nil)
end

local function directDescription(instance, role, rootLabel, confidence, detail)
  if instance == nil then return nil end
  return describe(instance, {
    roles = { [role] = true },
    details = { [role] = detail or {} },
    root = rootLabel,
    score = confidence * 1000,
  }, confidence)
end

local characterResult = {
  status = characterModel and ((humanoid and rootPart) and "resolved" or "partial") or "missing",
  player = localPlayer and safeName(localPlayer) or nil,
  source = characterSource,
  confidence = characterConfidence,
  custom = characterModel ~= nil and characterModel ~= standardCharacter or false,
  standardPath = standardCharacter and pathOf(standardCharacter) or nil,
  reason = characterModel and nil or "No standard, camera-subject, or bounded structural rig candidate was found.",
  model = directDescription(characterModel, "character", "character", characterConfidence, {
    source = characterSource,
  }),
  humanoid = directDescription(humanoid, "humanoid", "character", characterConfidence, nil),
  rootPart = directDescription(rootPart, "character-root", "character", characterConfidence, nil),
}

local cameraResult = {
  status = camera and "resolved" or "missing",
  entity = directDescription(camera, "camera", "workspace", camera and 1 or 0, nil),
  position = vector3(cameraPosition),
  lookVector = vector3(cameraLookVector),
  fieldOfView = camera and numberProperty(camera, "FieldOfView") or nil,
  subjectPath = cameraSubject and pathOf(cameraSubject) or nil,
}

local storedHandles = 0
if brain then
  for _ in pairs(brain.meta) do storedHandles = storedHandles + 1 end
end

return {
  ok = true,
  observedAt = NOW,
  limits = {
    radius = RADIUS,
    maxInstances = MAX_INSTANCES,
    maxResults = MAX_RESULTS,
    roots = ROOT_LIST,
    features = FEATURE_LIST,
  },
  origin = {
    source = originSource,
    position = vector3(origin),
  },
  character = characterResult,
  camera = cameraResult,
  entities = entities,
  scanned = {
    instances = scanned,
    queued = #queue,
    roots = #ROOT_LIST,
    byRoot = scannedByRoot,
  },
  returned = {
    entities = #entities,
    candidates = #candidates,
    byRole = roleCounts,
  },
  truncated = {
    instances = queueTruncated,
    results = #candidates > MAX_RESULTS,
  },
  handles = {
    enabled = brain ~= nil,
    session = SESSION_KEY,
    stored = storedHandles,
    weakReferences = brain and brain.weakReferences == true or false,
    error = brainError,
  },
  missing = missing,
}
`;

    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data, summary: observationSummary(data) };
  },
});
