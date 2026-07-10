import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

const DELTA_SOURCES = [
  "workspace",
  "playerGui",
  "character",
  "camera",
  "backpack",
  "watched",
] as const;

const EVENT_KINDS = [
  "workspace-descendant-added",
  "workspace-descendant-removing",
  "player-gui-descendant-added",
  "player-gui-descendant-removing",
  "player-gui-replaced",
  "character-added",
  "character-removing",
  "character-tool-added",
  "character-tool-removing",
  "camera-replaced",
  "camera-property-changed",
  "backpack-replaced",
  "backpack-tool-added",
  "backpack-tool-removing",
  "watched-property-changed",
] as const;

const DEFAULT_CAMERA_PROPERTIES = [
  "CameraType",
  "CameraSubject",
  "FieldOfView",
  "ViewportSize",
] as const;

function luaList(values: readonly string[]): string {
  return `{ ${values.map(q).join(", ")} }`;
}

function luaSet(values: readonly string[]): string {
  return `{ ${values.map((value) => `[${q(value)}] = true`).join(", ")} }`;
}

function luaWatches(
  watches: readonly { readonly instancePath: string; readonly properties: readonly string[] }[],
): string {
  if (watches.length === 0) return "{}";
  return (
    "{\n" +
    watches
      .map(
        (watch) =>
          `  { expression = ${q(watch.instancePath)}, properties = ${luaList([
            ...new Set(watch.properties),
          ])} },`,
      )
      .join("\n") +
    "\n}"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resultSummary(action: string, value: unknown): { summary: string; isError?: boolean } {
  const data = asRecord(value);
  if (!data) return { summary: `World-delta ${action} completed.` };
  if (typeof data["error"] === "string") {
    return { summary: `World-delta ${action} failed: ${data["error"]}`, isError: true };
  }

  const id = typeof data["observerId"] === "string" ? data["observerId"] : "observer";
  if (action === "start") {
    const connections = typeof data["connections"] === "number" ? data["connections"] : 0;
    return { summary: `${id} is observing live world deltas through ${connections} connections.` };
  }
  if (action === "poll") {
    const count = Array.isArray(data["events"]) ? data["events"].length : 0;
    const next = typeof data["nextCursor"] === "number" ? data["nextCursor"] : "unknown";
    const gap = data["cursorGap"] === true ? " A buffer gap was reported." : "";
    return { summary: `${id} returned ${count} delta event(s); nextCursor=${next}.${gap}` };
  }
  if (action === "stop") {
    const disconnected =
      typeof data["disconnectedConnections"] === "number" ? data["disconnectedConnections"] : 0;
    return { summary: `${id} stopped and disconnected ${disconnected} observer connection(s).` };
  }

  const status = typeof data["status"] === "string" ? data["status"] : "inactive";
  const active = data["active"] === true ? "active" : status;
  return { summary: `${id} is ${active}.` };
}

const watchedPropertySchema = z.object({
  instancePath: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      "Explicit Luau expression resolving to an Instance, such as game.Workspace.Door or " +
        "game.Players.LocalPlayer.PlayerGui.HUD. Expressions are evaluated only when action='start'.",
    ),
  properties: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(16)
    .describe("Instance properties to subscribe to through GetPropertyChangedSignal."),
});

const inputSchema = z
  .object({
    action: z
      .enum(["start", "poll", "status", "stop"])
      .describe(
        "start installs a bounded observer, poll reads events after cursor, status reports health without consuming " +
          "events, and stop disconnects every observer connection.",
      ),
    observerId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Observer id returned by start. For poll/status/stop, omission selects the newest active observer owned by " +
          "this MCP session.",
      ),
    cursor: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .default(0)
      .describe(
        "Poll returns events whose monotonically increasing cursor is greater than this value. Always persist the " +
          "returned nextCursor for the next poll.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe("Maximum events returned by one poll; hasMore indicates another page."),
    maxEvents: z
      .number()
      .int()
      .min(16)
      .max(2000)
      .optional()
      .default(500)
      .describe(
        "Start-only ring-buffer capacity. Older events are evicted at the cap and reported through droppedEvents, " +
          "droppedThrough, and cursorGap.",
      ),
    ttlSeconds: z
      .number()
      .int()
      .min(5)
      .max(3600)
      .optional()
      .default(300)
      .describe(
        "Start-only fixed lifetime. A delayed cleanup retires the observer and disconnects every connection even if " +
          "the AI never calls stop.",
      ),
    throttleMs: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .default(50)
      .describe(
        "Minimum interval for storing repeated events with the same semantic key after their coalescing window.",
      ),
    coalesceWindowMs: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .default(100)
      .describe(
        "Window in which identical source/kind/path/property events update one record and increment repeatCount.",
      ),
    filters: z
      .object({
        sources: z
          .array(z.enum(DELTA_SOURCES))
          .min(1)
          .max(DELTA_SOURCES.length)
          .optional()
          .describe("Event domains to subscribe to. Omit for all domains."),
        eventKinds: z
          .array(z.enum(EVENT_KINDS))
          .min(1)
          .max(EVENT_KINDS.length)
          .optional()
          .describe(
            "Optional allow-list of event kinds; omitted means every kind in selected sources.",
          ),
        classes: z
          .array(z.string().min(1).max(128))
          .min(1)
          .max(32)
          .optional()
          .describe("Optional exact ClassName allow-list."),
        nameContains: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            "Optional case-insensitive plain substring required in the changed Instance name.",
          ),
        pathContains: z
          .string()
          .min(1)
          .max(512)
          .optional()
          .describe(
            "Optional case-insensitive plain substring required in the full Instance path.",
          ),
      })
      .optional()
      .default({})
      .describe(
        "Start-only server-side filters, applied before an event consumes buffer capacity.",
      ),
    cameraProperties: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(16)
      .optional()
      .default([...DEFAULT_CAMERA_PROPERTIES])
      .describe(
        "Camera properties watched with GetPropertyChangedSignal. Add CFrame or Focus only when needed; throttling " +
          "protects high-frequency properties.",
      ),
    watchedProperties: z
      .array(watchedPropertySchema)
      .max(16)
      .optional()
      .default([])
      .describe(
        "Additional explicit Instance/property subscriptions. At most 16 targets and 64 aggregate property " +
          "connections are allowed.",
      ),
    threadContext: z.number().int().optional(),
  })
  .superRefine((input, refinement) => {
    const propertyCount = input.watchedProperties.reduce(
      (count, watch) => count + new Set(watch.properties).size,
      0,
    );
    if (propertyCount > 64) {
      refinement.addIssue({
        code: "custom",
        path: ["watchedProperties"],
        message: "watchedProperties may request at most 64 unique target/property connections",
      });
    }
  });

export default defineTool({
  name: "world-delta",
  title: "Stream bounded event-driven world changes",
  description:
    "WRITES LIVE CLIENT OBSERVER STATE — installs RBXScriptConnections and a bounded getgenv registry, but never " +
    "modifies gameplay Instances. action='start' subscribes to Workspace and PlayerGui descendant additions/removals, " +
    "character spawn/removal and equipped Tool changes, CurrentCamera replacement and selected camera properties, " +
    "Backpack Tool changes, plus explicitly requested Instance properties. action='poll' returns cursor-ordered deltas; " +
    "action='status' reports observer health; action='stop' disconnects every connection. Events are filtered before " +
    "storage, repeated noise is coalesced/throttled, the ring buffer reports every capacity eviction, and a fixed TTL " +
    "runs the same cleanup path automatically. It uses Roblox signals only: no RenderStepped, per-frame polling, or " +
    "world scans.",
  category: "Intelligence",
  mutatesState: true,
  ai: {
    phase: "observe",
    prerequisites: [
      "active-client",
      "getgenv capability",
      "a bounded observation goal and relevant source filters",
    ],
    consumes: [
      "world-change observation goal",
      "optional Instance/property expressions",
      "previous nextCursor",
    ],
    produces: [
      "event-driven-world-deltas",
      "monotonic-cursor",
      "buffer-gap-and-drop-accounting",
      "observer-health-and-expiry",
      "coalescing-and-throttle-statistics",
    ],
    verifiesWith: ["observe-world"],
    alternatives: ["observe-world", "watch-property-changes", "watch-instance-property"],
    requiresCapabilities: ["getgenv"],
    sideEffects: [
      "installs bounded RBXScriptConnections in the active client",
      "stores bounded observer metadata and events in getgenv.__mcp_world_delta",
      "schedules one TTL cleanup callback; no gameplay Instance is written",
    ],
    failureRecovery: [
      "If start reports watchErrors, correct only those expressions/properties and start a replacement observer.",
      "If poll reports cursorGap, treat droppedSinceCursor as missing history and call observe-world for a fresh snapshot.",
      "Persist nextCursor after every poll; never invent or advance a cursor beyond latestCursor.",
      "If noise is high, narrow filters or raise throttleMs before increasing maxEvents.",
      "Always call stop when the task ends; TTL is a leak guard, not the normal lifecycle.",
      "After a transport reconnect, call status before trusting an old observer id.",
    ],
  },
  input: inputSchema,
  async execute(
    {
      action,
      observerId,
      cursor,
      limit,
      maxEvents,
      ttlSeconds,
      throttleMs,
      coalesceWindowMs,
      filters,
      cameraProperties,
      watchedProperties,
      threadContext,
    },
    ctx,
  ) {
    if (action === "start" && observerId !== undefined) {
      return {
        data: { error: "observerId is assigned by world-delta start; omit it when starting." },
        summary: "World-delta start failed: omit observerId and use the id returned by start.",
        isError: true,
      };
    }

    const sources = [...new Set(filters.sources ?? DELTA_SOURCES)];
    const eventKinds = [...new Set(filters.eventKinds ?? [])];
    const classes = [...new Set(filters.classes ?? [])];
    const cameras = [...new Set(cameraProperties)];
    const safeMaxEvents = Math.min(Math.max(Math.floor(maxEvents), 16), 2000);
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    const safeTtl = Math.min(Math.max(Math.floor(ttlSeconds), 5), 3600);
    const safeThrottle = Math.min(Math.max(Math.floor(throttleMs), 0), 5000);
    const safeCoalesce = Math.min(Math.max(Math.floor(coalesceWindowMs), 0), 5000);
    const sessionKey = String(ctx.session.id);

    const source = `
local ACTION = ${q(action)}
local REQUESTED_ID = ${observerId === undefined ? "nil" : q(observerId)}
local SESSION_KEY = ${q(sessionKey)}
local REQUEST_CURSOR = ${Math.floor(cursor)}
local POLL_LIMIT = ${safeLimit}
local MAX_EVENTS = ${safeMaxEvents}
local TTL_SECONDS = ${safeTtl}
local THROTTLE_MS = ${safeThrottle}
local COALESCE_WINDOW_MS = ${safeCoalesce}
local SOURCE_LIST = ${luaList(sources)}
local SOURCE_FILTER = ${luaSet(sources)}
local EVENT_KIND_LIST = ${luaList(eventKinds)}
local EVENT_KIND_FILTER = ${luaSet(eventKinds)}
local CLASS_LIST = ${luaList(classes)}
local CLASS_FILTER = ${luaSet(classes)}
local NAME_CONTAINS = ${filters.nameContains === undefined ? "nil" : q(filters.nameContains.toLowerCase())}
local PATH_CONTAINS = ${filters.pathContains === undefined ? "nil" : q(filters.pathContains.toLowerCase())}
local CAMERA_PROPERTIES = ${luaList(cameras)}
local WATCHES = ${luaWatches(watchedProperties)}

local REGISTRY_KEY = "__mcp_world_delta"
local REGISTRY_VERSION = 1
local HARD_MAX_OBSERVERS = 8
local HARD_MAX_SESSION_OBSERVERS = 4
local HARD_MAX_TOMBSTONES = 16
local HARD_MAX_EVENTS = 2000
local HARD_MAX_WATCH_TARGETS = 16
local HARD_MAX_WATCH_PROPERTIES = 64
local HARD_MAX_WARNINGS = 32

local function now()
  return os.clock()
end

local function safeService(name)
  local ok, value = pcall(function() return game:GetService(name) end)
  if ok and typeof(value) == "Instance" then return value end
  return nil
end

local function safeClass(instance)
  if typeof(instance) ~= "Instance" then return nil end
  local ok, value = pcall(function() return instance.ClassName end)
  return ok and tostring(value) or nil
end

local function safeName(instance)
  if typeof(instance) ~= "Instance" then return nil end
  local ok, value = pcall(function() return instance.Name end)
  return ok and tostring(value) or nil
end

local function safePath(instance)
  if typeof(instance) ~= "Instance" then return nil end
  local ok, value = pcall(function() return instance:GetFullName() end)
  return ok and tostring(value) or tostring(instance)
end

local function isA(instance, className)
  if typeof(instance) ~= "Instance" then return false end
  local ok, value = pcall(function() return instance:IsA(className) end)
  return ok and value == true
end

local function limitedString(value)
  local text = tostring(value)
  if #text > 512 then return string.sub(text, 1, 512) .. "…" end
  return text
end

local function encodeValue(value)
  local kind = typeof(value)
  if kind == "nil" or kind == "boolean" or kind == "number" then return value end
  if kind == "string" then return limitedString(value) end
  if kind == "Instance" then
    return { type = "Instance", path = safePath(value), className = safeClass(value) }
  end
  local ok, text = pcall(tostring, value)
  return { type = kind, value = ok and limitedString(text) or "<unprintable>" }
end

local function readProperty(instance, property)
  local ok, value = pcall(function() return instance[property] end)
  if not ok then return { unreadable = true, error = limitedString(value) } end
  return encodeValue(value)
end

if type(getgenv) ~= "function" then
  return { error = "getgenv is not available; world-delta cannot preserve observer connections across calls." }
end
local okEnv, env = pcall(getgenv)
if not okEnv or type(env) ~= "table" then
  return { error = "getgenv did not return a usable table; world-delta cannot create its bounded registry." }
end

local registry = env[REGISTRY_KEY]
if registry == nil then
  registry = {
    version = REGISTRY_VERSION,
    nextObserverId = 0,
    observers = {},
    tombstones = {},
    tombstoneOrder = {},
  }
  env[REGISTRY_KEY] = registry
elseif type(registry) ~= "table" or registry.version ~= REGISTRY_VERSION
  or type(registry.observers) ~= "table" or type(registry.tombstones) ~= "table" then
  return { error = "Refusing to overwrite unknown or corrupt getgenv.__mcp_world_delta state." }
end

local function addWarning(state, message)
  if #state.warnings < HARD_MAX_WARNINGS then
    state.warnings[#state.warnings + 1] = limitedString(message)
  else
    state.droppedWarnings = state.droppedWarnings + 1
  end
end

local function disconnectGroup(state, groupName)
  local group = state.groups[groupName]
  if type(group) ~= "table" then
    state.groups[groupName] = {}
    return 0
  end
  local disconnected = 0
  for _, connection in ipairs(group) do
    if connection ~= nil then
      local ok = pcall(function() connection:Disconnect() end)
      if ok then disconnected = disconnected + 1 end
    end
  end
  state.groups[groupName] = {}
  return disconnected
end

local function disconnectState(state, reason)
  if state.cleanupReason ~= nil then return state.disconnectedConnections or 0 end
  state.active = false
  if reason ~= "expired" and state.expiryThread ~= nil and type(task.cancel) == "function" then
    pcall(task.cancel, state.expiryThread)
  end
  state.expiryThread = nil
  local disconnected = 0
  for groupName in pairs(state.groups) do
    disconnected = disconnected + disconnectGroup(state, groupName)
  end
  state.cleanupReason = reason
  state.disconnectedConnections = disconnected
  state.coalesce = {}
  state.lastEmitted = {}
  state.boundCamera = nil
  state.boundCharacter = nil
  state.boundPlayerGui = nil
  state.boundBackpack = nil
  return disconnected
end

local function recordTombstone(state, reason)
  local tombstone = {
    observerId = state.id,
    ownerSession = state.ownerSession,
    active = false,
    status = reason,
    stoppedAt = now(),
    latestCursor = state.cursor,
    nextCursor = state.cursor,
    droppedEvents = state.droppedEvents,
    coalescedEvents = state.coalescedEvents,
    throttledEvents = state.throttledEvents,
    disconnectedConnections = state.disconnectedConnections or 0,
  }
  registry.tombstones[state.id] = tombstone
  registry.tombstoneOrder[#registry.tombstoneOrder + 1] = state.id
  while #registry.tombstoneOrder > HARD_MAX_TOMBSTONES do
    local oldest = table.remove(registry.tombstoneOrder, 1)
    if oldest ~= state.id then registry.tombstones[oldest] = nil end
  end
  return tombstone
end

local function retireState(state, reason)
  local disconnected = disconnectState(state, reason)
  if registry.observers[state.id] == state then registry.observers[state.id] = nil end
  local tombstone = recordTombstone(state, reason)
  state.events = {}
  state.eventHead = 1
  state.eventTail = 0
  state.eventCount = 0
  return tombstone, disconnected
end

local function cleanupExpired()
  local timestamp = now()
  local expired = {}
  for _, state in pairs(registry.observers) do
    if state.active == true and state.expiresAt <= timestamp then
      expired[#expired + 1] = state
    end
  end
  for _, state in ipairs(expired) do retireState(state, "expired") end
end

cleanupExpired()

local function findState()
  if REQUESTED_ID ~= nil then
    local state = registry.observers[REQUESTED_ID]
    if state ~= nil and state.ownerSession == SESSION_KEY then return state, nil end
    local tombstone = registry.tombstones[REQUESTED_ID]
    if tombstone ~= nil and tombstone.ownerSession == SESSION_KEY then return nil, tombstone end
    return nil, nil
  end

  local newest = nil
  for _, state in pairs(registry.observers) do
    if state.ownerSession == SESSION_KEY and state.active == true
      and (newest == nil or state.sequence > newest.sequence) then
      newest = state
    end
  end
  return newest, nil
end

local function connectionCount(state)
  local total = 0
  for _, group in pairs(state.groups) do
    if type(group) == "table" then total = total + #group end
  end
  return total
end

local function statusOf(state)
  return {
    observerId = state.id,
    active = state.active == true,
    status = state.active == true and "active" or (state.cleanupReason or "inactive"),
    ageMs = math.max(0, math.floor((now() - state.createdAt) * 1000)),
    expiresInMs = math.max(0, math.floor((state.expiresAt - now()) * 1000)),
    connections = connectionCount(state),
    maxEvents = state.maxEvents,
    bufferedEvents = state.eventCount,
    latestCursor = state.cursor,
    nextCursor = state.cursor,
    droppedEvents = state.droppedEvents,
    droppedThrough = state.droppedThrough,
    coalescedEvents = state.coalescedEvents,
    throttledEvents = state.throttledEvents,
    filteredEvents = state.filteredEvents,
    rawEvents = state.rawEvents,
    sourceCounts = state.sourceCounts,
    warnings = state.warnings,
    droppedWarnings = state.droppedWarnings,
    filters = state.filterSummary,
    watchedPropertyConnections = state.watchedPropertyConnections,
  }
end

local function publicEvent(event)
  return {
    cursor = event.cursor,
    source = event.source,
    kind = event.kind,
    elapsedMs = event.elapsedMs,
    lastElapsedMs = event.lastElapsedMs,
    repeatCount = event.repeatCount,
    path = event.path,
    name = event.name,
    className = event.className,
    property = event.property,
    detail = event.detail,
  }
end

if ACTION ~= "start" then
  local state, tombstone = findState()
  if state == nil then
    if tombstone ~= nil then
      if ACTION == "stop" then
        return {
          observerId = tombstone.observerId,
          stopped = true,
          alreadyStopped = true,
          status = tombstone.status,
          latestCursor = tombstone.latestCursor,
          droppedEvents = tombstone.droppedEvents,
          disconnectedConnections = tombstone.disconnectedConnections,
        }
      end
      return tombstone
    end
    return { error = "No active world-delta observer owned by this MCP session. Start one first." }
  end

  if ACTION == "status" then return statusOf(state) end

  if ACTION == "stop" then
    local final = statusOf(state)
    local tombstone, disconnected = retireState(state, "stopped")
    return {
      observerId = state.id,
      stopped = true,
      alreadyStopped = false,
      status = tombstone.status,
      latestCursor = final.latestCursor,
      bufferedEvents = final.bufferedEvents,
      droppedEvents = final.droppedEvents,
      coalescedEvents = final.coalescedEvents,
      throttledEvents = final.throttledEvents,
      disconnectedConnections = disconnected,
    }
  end

  if ACTION ~= "poll" then return { error = "Unsupported world-delta action: " .. tostring(ACTION) } end
  if REQUEST_CURSOR > state.cursor then
    return {
      error = "cursor is ahead of the observer's latestCursor; reuse the last nextCursor returned by poll.",
      observerId = state.id,
      requestedCursor = REQUEST_CURSOR,
      latestCursor = state.cursor,
      nextCursor = state.cursor,
    }
  end

  local effectiveCursor = REQUEST_CURSOR
  local cursorGap = effectiveCursor < state.droppedThrough
  local droppedSinceCursor = 0
  if cursorGap then
    droppedSinceCursor = state.droppedThrough - effectiveCursor
    effectiveCursor = state.droppedThrough
  end

  local events = {}
  local nextCursor = effectiveCursor
  local hasMore = false
  for index = state.eventHead, state.eventTail do
    local event = state.events[index]
    if event ~= nil and event.active == true and event.cursor > effectiveCursor then
      if #events < POLL_LIMIT then
        events[#events + 1] = publicEvent(event)
        nextCursor = event.cursor
      else
        hasMore = true
        break
      end
    end
  end

  return {
    observerId = state.id,
    active = true,
    events = events,
    returned = #events,
    requestedCursor = REQUEST_CURSOR,
    nextCursor = nextCursor,
    latestCursor = state.cursor,
    hasMore = hasMore,
    cursorGap = cursorGap,
    droppedSinceCursor = droppedSinceCursor,
    droppedEvents = state.droppedEvents,
    droppedThrough = state.droppedThrough,
    coalescedEvents = state.coalescedEvents,
    throttledEvents = state.throttledEvents,
    expiresInMs = math.max(0, math.floor((state.expiresAt - now()) * 1000)),
  }
end

if MAX_EVENTS > HARD_MAX_EVENTS then return { error = "maxEvents exceeds the hard safety cap." } end
if #WATCHES > HARD_MAX_WATCH_TARGETS then return { error = "Too many watched Instance targets." } end
local requestedWatchProperties = 0
for _, watch in ipairs(WATCHES) do requestedWatchProperties = requestedWatchProperties + #watch.properties end
if requestedWatchProperties > HARD_MAX_WATCH_PROPERTIES then
  return { error = "Too many watched target/property connections." }
end

local observerCount = 0
local sessionObserverCount = 0
for _, state in pairs(registry.observers) do
  observerCount = observerCount + 1
  if state.ownerSession == SESSION_KEY then sessionObserverCount = sessionObserverCount + 1 end
end
if observerCount >= HARD_MAX_OBSERVERS then
  return { error = "The bounded world-delta registry is full; stop an observer before starting another." }
end
if sessionObserverCount >= HARD_MAX_SESSION_OBSERVERS then
  return { error = "This MCP session already owns the maximum number of world-delta observers." }
end

registry.nextObserverId = (tonumber(registry.nextObserverId) or 0) + 1
local observerId = "wd:" .. tostring(registry.nextObserverId)
local createdAt = now()
local state = {
  id = observerId,
  sequence = registry.nextObserverId,
  ownerSession = SESSION_KEY,
  active = true,
  createdAt = createdAt,
  expiresAt = createdAt + TTL_SECONDS,
  maxEvents = MAX_EVENTS,
  events = {},
  eventHead = 1,
  eventTail = 0,
  eventCount = 0,
  cursor = 0,
  droppedEvents = 0,
  droppedThrough = 0,
  coalescedEvents = 0,
  throttledEvents = 0,
  filteredEvents = 0,
  rawEvents = 0,
  groups = { static = {}, camera = {}, character = {}, playerGui = {}, backpack = {}, watched = {} },
  coalesce = {},
  lastEmitted = {},
  sourceCounts = {},
  warnings = {},
  droppedWarnings = 0,
  watchedPropertyConnections = 0,
  filterSummary = {
    sources = SOURCE_LIST,
    eventKinds = EVENT_KIND_LIST,
    classes = CLASS_LIST,
    nameContains = NAME_CONTAINS,
    pathContains = PATH_CONTAINS,
    throttleMs = THROTTLE_MS,
    coalesceWindowMs = COALESCE_WINDOW_MS,
  },
}
registry.observers[observerId] = state

local HAS_EVENT_KIND_FILTER = next(EVENT_KIND_FILTER) ~= nil
local HAS_CLASS_FILTER = next(CLASS_FILTER) ~= nil

local function passesFilters(sourceName, kind, instance, name, path)
  if SOURCE_FILTER[sourceName] ~= true then return false end
  if HAS_EVENT_KIND_FILTER and EVENT_KIND_FILTER[kind] ~= true then return false end
  if HAS_CLASS_FILTER then
    local className = safeClass(instance)
    if className == nil or CLASS_FILTER[className] ~= true then return false end
  end
  if NAME_CONTAINS ~= nil then
    if name == nil or string.find(string.lower(name), NAME_CONTAINS, 1, true) == nil then return false end
  end
  if PATH_CONTAINS ~= nil then
    if path == nil or string.find(string.lower(path), PATH_CONTAINS, 1, true) == nil then return false end
  end
  return true
end

local function compactEvents()
  if state.eventHead <= 4096 or state.eventHead <= math.floor(state.eventTail / 2) then return end
  local compacted = {}
  local count = 0
  for index = state.eventHead, state.eventTail do
    local event = state.events[index]
    if event ~= nil then
      count = count + 1
      compacted[count] = event
    end
  end
  state.events = compacted
  state.eventHead = 1
  state.eventTail = count
end

local function appendEvent(event, key, timestamp)
  state.eventTail = state.eventTail + 1
  state.events[state.eventTail] = event
  state.eventCount = state.eventCount + 1
  state.coalesce[key] = { event = event, firstAt = timestamp }
  state.lastEmitted[key] = { event = event, at = timestamp }

  while state.eventCount > state.maxEvents do
    local removed = state.events[state.eventHead]
    state.events[state.eventHead] = nil
    state.eventHead = state.eventHead + 1
    state.eventCount = state.eventCount - 1
    if removed ~= nil then
      removed.active = false
      state.droppedEvents = state.droppedEvents + 1
      state.droppedThrough = math.max(state.droppedThrough, removed.cursor or 0)
      local removedKey = removed.key
      local bucket = removedKey and state.coalesce[removedKey] or nil
      if bucket ~= nil and bucket.event == removed then state.coalesce[removedKey] = nil end
      local last = removedKey and state.lastEmitted[removedKey] or nil
      if last ~= nil and last.event == removed then state.lastEmitted[removedKey] = nil end
    end
  end
  compactEvents()
end

local function emit(sourceName, kind, instance, property, detail)
  if state.active ~= true then return end
  state.rawEvents = state.rawEvents + 1
  local name = safeName(instance)
  local path = safePath(instance)
  if not passesFilters(sourceName, kind, instance, name, path) then
    state.filteredEvents = state.filteredEvents + 1
    return
  end

  local timestamp = now()
  local elapsedMs = math.max(0, math.floor((timestamp - state.createdAt) * 1000))
  local key = sourceName .. "|" .. kind .. "|" .. tostring(path or "<none>") .. "|" .. tostring(property or "")
  local bucket = state.coalesce[key]
  if bucket ~= nil and bucket.event ~= nil and bucket.event.active == true
    and (timestamp - bucket.firstAt) * 1000 <= COALESCE_WINDOW_MS then
    local event = bucket.event
    event.repeatCount = event.repeatCount + 1
    event.lastElapsedMs = elapsedMs
    if detail ~= nil then event.detail = detail end
    state.coalescedEvents = state.coalescedEvents + 1
    return
  end

  local last = state.lastEmitted[key]
  if last ~= nil and (timestamp - last.at) * 1000 < THROTTLE_MS then
    state.throttledEvents = state.throttledEvents + 1
    return
  end

  state.cursor = state.cursor + 1
  local event = {
    cursor = state.cursor,
    source = sourceName,
    kind = kind,
    elapsedMs = elapsedMs,
    lastElapsedMs = elapsedMs,
    repeatCount = 1,
    path = path,
    name = name,
    className = safeClass(instance),
    property = property,
    detail = detail,
    key = key,
    active = true,
  }
  state.sourceCounts[sourceName] = (state.sourceCounts[sourceName] or 0) + 1
  appendEvent(event, key, timestamp)
end

local function connectSignal(groupName, signal, label, callback)
  if state.active ~= true then return nil end
  if typeof(signal) ~= "RBXScriptSignal" then
    addWarning(state, label .. " is not an RBXScriptSignal")
    return nil
  end
  local ok, connection = pcall(function()
    return signal:Connect(function(...)
      if state.active ~= true then return end
      local callbackOk, callbackError = pcall(callback, ...)
      if not callbackOk then addWarning(state, label .. " callback failed: " .. tostring(callbackError)) end
    end)
  end)
  if not ok or connection == nil then
    addWarning(state, "Could not connect " .. label .. ": " .. tostring(connection))
    return nil
  end
  local group = state.groups[groupName]
  group[#group + 1] = connection
  return connection
end

local function propertySignal(instance, property)
  local ok, signal = pcall(function() return instance:GetPropertyChangedSignal(property) end)
  if ok then return signal, nil end
  return nil, signal
end

local Workspace = safeService("Workspace") or workspace
local Players = safeService("Players")
local LocalPlayer = Players and Players.LocalPlayer or nil

local bindCamera
local bindCharacter
local bindPlayerGui
local bindBackpack

bindCamera = function(camera)
  disconnectGroup(state, "camera")
  state.boundCamera = camera
  if typeof(camera) ~= "Instance" then return end
  for _, property in ipairs(CAMERA_PROPERTIES) do
    local cameraInstance = camera
    local cameraProperty = property
    local signal, signalError = propertySignal(cameraInstance, cameraProperty)
    if signal ~= nil then
      connectSignal("camera", signal, "camera." .. cameraProperty, function()
        emit("camera", "camera-property-changed", cameraInstance, cameraProperty, {
          value = readProperty(cameraInstance, cameraProperty),
        })
      end)
    else
      addWarning(state, "Camera property " .. cameraProperty .. " is unavailable: " .. tostring(signalError))
    end
  end
end

bindCharacter = function(character)
  disconnectGroup(state, "character")
  state.boundCharacter = character
  if typeof(character) ~= "Instance" or SOURCE_FILTER.character ~= true then return end
  connectSignal("character", character.DescendantAdded, "Character.DescendantAdded", function(instance)
    if isA(instance, "Tool") then emit("character", "character-tool-added", instance, nil, nil) end
  end)
  connectSignal("character", character.DescendantRemoving, "Character.DescendantRemoving", function(instance)
    if isA(instance, "Tool") then emit("character", "character-tool-removing", instance, nil, nil) end
  end)
end

bindPlayerGui = function(playerGui)
  disconnectGroup(state, "playerGui")
  state.boundPlayerGui = playerGui
  if typeof(playerGui) ~= "Instance" or SOURCE_FILTER.playerGui ~= true then return end
  connectSignal("playerGui", playerGui.DescendantAdded, "PlayerGui.DescendantAdded", function(instance)
    emit("playerGui", "player-gui-descendant-added", instance, nil, nil)
  end)
  connectSignal("playerGui", playerGui.DescendantRemoving, "PlayerGui.DescendantRemoving", function(instance)
    emit("playerGui", "player-gui-descendant-removing", instance, nil, nil)
  end)
end

bindBackpack = function(backpack)
  disconnectGroup(state, "backpack")
  state.boundBackpack = backpack
  if typeof(backpack) ~= "Instance" or SOURCE_FILTER.backpack ~= true then return end
  connectSignal("backpack", backpack.DescendantAdded, "Backpack.DescendantAdded", function(instance)
    if isA(instance, "Tool") then emit("backpack", "backpack-tool-added", instance, nil, nil) end
  end)
  connectSignal("backpack", backpack.DescendantRemoving, "Backpack.DescendantRemoving", function(instance)
    if isA(instance, "Tool") then emit("backpack", "backpack-tool-removing", instance, nil, nil) end
  end)
end

if typeof(Workspace) == "Instance" and SOURCE_FILTER.workspace == true then
  connectSignal("static", Workspace.DescendantAdded, "Workspace.DescendantAdded", function(instance)
    emit("workspace", "workspace-descendant-added", instance, nil, nil)
  end)
  connectSignal("static", Workspace.DescendantRemoving, "Workspace.DescendantRemoving", function(instance)
    emit("workspace", "workspace-descendant-removing", instance, nil, nil)
  end)
elseif SOURCE_FILTER.workspace == true then
  addWarning(state, "Workspace is unavailable")
end

if typeof(Workspace) == "Instance" and SOURCE_FILTER.camera == true then
  local currentCameraSignal, currentCameraError = propertySignal(Workspace, "CurrentCamera")
  if currentCameraSignal ~= nil then
    connectSignal("static", currentCameraSignal, "Workspace.CurrentCamera", function()
      local previous = state.boundCamera
      local ok, current = pcall(function() return Workspace.CurrentCamera end)
      if not ok then current = nil end
      bindCamera(current)
      emit("camera", "camera-replaced", current or previous, "CurrentCamera", {
        previousPath = safePath(previous),
        currentPath = safePath(current),
      })
    end)
  else
    addWarning(state, "CurrentCamera signal is unavailable: " .. tostring(currentCameraError))
  end
  local ok, current = pcall(function() return Workspace.CurrentCamera end)
  bindCamera(ok and current or nil)
end

if typeof(LocalPlayer) == "Instance" then
  if SOURCE_FILTER.character == true then
    connectSignal("static", LocalPlayer.CharacterAdded, "LocalPlayer.CharacterAdded", function(character)
      emit("character", "character-added", character, nil, nil)
      bindCharacter(character)
    end)
    connectSignal("static", LocalPlayer.CharacterRemoving, "LocalPlayer.CharacterRemoving", function(character)
      emit("character", "character-removing", character, nil, nil)
      if state.boundCharacter == character then bindCharacter(nil) end
    end)
    local ok, character = pcall(function() return LocalPlayer.Character end)
    bindCharacter(ok and character or nil)
  end

  if SOURCE_FILTER.playerGui == true or SOURCE_FILTER.backpack == true then
    connectSignal("static", LocalPlayer.ChildAdded, "LocalPlayer.ChildAdded", function(child)
      if SOURCE_FILTER.playerGui == true and isA(child, "PlayerGui") then
        local previous = state.boundPlayerGui
        bindPlayerGui(child)
        emit("playerGui", "player-gui-replaced", child, nil, { previousPath = safePath(previous) })
      elseif SOURCE_FILTER.backpack == true and isA(child, "Backpack") then
        local previous = state.boundBackpack
        bindBackpack(child)
        emit("backpack", "backpack-replaced", child, nil, { previousPath = safePath(previous) })
      end
    end)
    connectSignal("static", LocalPlayer.ChildRemoved, "LocalPlayer.ChildRemoved", function(child)
      if child == state.boundPlayerGui then
        emit("playerGui", "player-gui-replaced", child, nil, { removed = true })
        bindPlayerGui(nil)
      elseif child == state.boundBackpack then
        emit("backpack", "backpack-replaced", child, nil, { removed = true })
        bindBackpack(nil)
      end
    end)
  end

  if SOURCE_FILTER.playerGui == true then
    local ok, playerGui = pcall(function() return LocalPlayer:FindFirstChildOfClass("PlayerGui") end)
    bindPlayerGui(ok and playerGui or nil)
    if state.boundPlayerGui == nil then addWarning(state, "PlayerGui is unavailable at observer start") end
  end
  if SOURCE_FILTER.backpack == true then
    local ok, backpack = pcall(function() return LocalPlayer:FindFirstChildOfClass("Backpack") end)
    bindBackpack(ok and backpack or nil)
    if state.boundBackpack == nil then addWarning(state, "Backpack is unavailable at observer start") end
  end
elseif SOURCE_FILTER.character == true or SOURCE_FILTER.playerGui == true or SOURCE_FILTER.backpack == true then
  addWarning(state, "Players.LocalPlayer is unavailable; player-owned sources were not connected")
end

local function evaluateInstance(expression)
  if type(loadstring) ~= "function" then return nil, "loadstring is unavailable" end
  local fn, compileError = loadstring("return " .. expression)
  if fn == nil then return nil, "compile error: " .. tostring(compileError) end
  local ok, value = pcall(fn)
  if not ok then return nil, "evaluation error: " .. tostring(value) end
  if typeof(value) ~= "Instance" then return nil, "expression resolved to " .. typeof(value) .. ", not Instance" end
  return value, nil
end

if SOURCE_FILTER.watched == true then
  for _, watch in ipairs(WATCHES) do
    local watchExpression = watch.expression
    local instance, watchError = evaluateInstance(watchExpression)
    if instance == nil then
      addWarning(state, "Watch " .. watchExpression .. " failed: " .. tostring(watchError))
    else
      for _, property in ipairs(watch.properties) do
        local watchedInstance = instance
        local watchedProperty = property
        local signal, signalError = propertySignal(watchedInstance, watchedProperty)
        if signal ~= nil then
          local connected = connectSignal("watched", signal, "watch " .. watchExpression .. "." .. watchedProperty, function()
            emit("watched", "watched-property-changed", watchedInstance, watchedProperty, {
              expression = watchExpression,
              value = readProperty(watchedInstance, watchedProperty),
            })
          end)
          if connected ~= nil then state.watchedPropertyConnections = state.watchedPropertyConnections + 1 end
        else
          addWarning(state, "Watch " .. watchExpression .. "." .. watchedProperty .. " failed: " .. tostring(signalError))
        end
      end
    end
  end
end

local scheduled, expiryThreadOrError = pcall(function()
  return task.delay(TTL_SECONDS, function()
    pcall(function()
      local current = registry.observers[observerId]
      if current == state and state.active == true then
        retireState(state, "expired")
      end
    end)
  end)
end)
if not scheduled then
  retireState(state, "start-failed")
  return { error = "Could not schedule mandatory TTL cleanup: " .. tostring(expiryThreadOrError) }
end
state.expiryThread = expiryThreadOrError

local result = statusOf(state)
result.started = true
result.nextCursor = 0
return result
`;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    const summary = resultSummary(action, data);
    return { data, ...summary };
  },
});
