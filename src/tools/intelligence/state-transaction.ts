import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { PRELUDE, q, RESOLVE_PRELUDE } from "../_shared/luau.js";

const ACTIONS = ["begin", "capture", "status", "commit", "rollback", "cleanup"] as const;
const MAX_TRANSACTIONS = 32;
const MAX_ITEMS = 256;
const DEFAULT_ITEMS = 128;
const DEFAULT_EXPIRY_SECONDS = 900;
const MAX_CLEANUP_WORK = 512;

const fieldNameSchema = z
  .string()
  .min(1)
  .max(100)
  .describe("Exact Instance property or attribute name.");

const targetSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .describe("Dotted Instance path resolved without evaluating arbitrary Luau."),
  properties: z
    .array(fieldNameSchema)
    .max(32)
    .optional()
    .default([])
    .describe("Explicit Instance properties to snapshot. No implicit property sweep is performed."),
  attributes: z
    .array(fieldNameSchema)
    .max(32)
    .optional()
    .default([])
    .describe("Explicit attributes to snapshot, including whether each attribute was absent."),
});

const cleanupItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("drawing"),
    id: z
      .number()
      .int()
      .nonnegative()
      .max(2_147_483_647)
      .describe("Drawing id from draw-create/list-drawings to remove during rollback."),
  }),
  z.object({
    kind: z.literal("virtual-input"),
    inputType: z
      .enum(["key", "mouse-button", "touch", "gamepad-button"])
      .describe("Held input type that must receive its matching release/end event."),
    key: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Enum.KeyCode member for key or gamepad-button cleanup."),
    button: z.enum(["Left", "Right", "Middle"]).optional().default("Left"),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    touchId: z.number().int().nonnegative().max(1_000_000).optional().default(0),
    gamepad: z
      .enum(["Gamepad1", "Gamepad2", "Gamepad3", "Gamepad4"])
      .optional()
      .default("Gamepad1"),
  }),
  z.object({
    kind: z.literal("connection"),
    expression: z
      .string()
      .min(1)
      .max(1000)
      .describe(
        "Luau expression resolving to an RBXScriptConnection. The object reference is captured immediately.",
      ),
    rollbackAction: z
      .enum(["restore-state", "disconnect"])
      .optional()
      .default("disconnect")
      .describe(
        "restore-state re-applies the captured Enabled state; disconnect is cleanup-only and cannot recreate a connection.",
      ),
  }),
  z.object({
    kind: z.literal("hook"),
    key: z
      .string()
      .min(1)
      .max(1000)
      .describe("Exact key in the canonical __mcp_hooks/__mcp_hook_meta registries."),
  }),
]);

type Target = z.infer<typeof targetSchema>;
type CleanupItem = z.infer<typeof cleanupItemSchema>;

function stringArray(values: readonly string[]): string {
  return `{ ${values.map((value) => q(value)).join(", ")} }`;
}

function targetsLiteral(targets: readonly Target[]): string {
  return `{ ${targets
    .map(
      (target) =>
        `{ path = ${q(target.path)}, properties = ${stringArray(target.properties)}, attributes = ${stringArray(target.attributes)} }`,
    )
    .join(", ")} }`;
}

function cleanupItemsLiteral(items: readonly CleanupItem[]): string {
  return `{ ${items
    .map((item) => {
      if (item.kind === "drawing") {
        return `{ kind = "drawing", id = ${String(item.id)} }`;
      }
      if (item.kind === "virtual-input") {
        return (
          `{ kind = "virtual-input", inputType = ${q(item.inputType)}, key = ${q(item.key ?? "")}, ` +
          `button = ${q(item.button)}, x = ${item.x === undefined ? "nil" : String(item.x)}, ` +
          `y = ${item.y === undefined ? "nil" : String(item.y)}, touchId = ${String(item.touchId)}, ` +
          `gamepad = ${q(item.gamepad)} }`
        );
      }
      if (item.kind === "connection") {
        return `{ kind = "connection", expression = ${q(item.expression)}, rollbackAction = ${q(item.rollbackAction)} }`;
      }
      return `{ kind = "hook", key = ${q(item.key)} }`;
    })
    .join(", ")} }`;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numeric(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function resultSummary(action: (typeof ACTIONS)[number], data: unknown): string {
  const record = recordOf(data);
  if (typeof record?.["error"] === "string") return `State transaction failed: ${record["error"]}`;
  const id =
    typeof record?.["transactionId"] === "string" ? record["transactionId"] : "transaction";
  if (action === "begin") return `Started ${id} with a bounded reversible-state journal.`;
  if (action === "capture") {
    const report = recordOf(record?.["capture"]);
    return `Captured ${numeric(report, "captured")} item(s) and reported ${numeric(report, "failed") + numeric(report, "unsupported")} issue(s) for ${id}.`;
  }
  if (action === "status") {
    const count = numeric(record, "count") || (record?.["transactionId"] ? 1 : 0);
    return `Reported ${count} state transaction(s).`;
  }
  if (action === "commit") {
    return `Committed ${id}; ${numeric(record, "discardedItems")} journal item(s) were discarded without restoration.`;
  }
  if (action === "rollback") {
    return `Rolled back ${id}: ${numeric(record, "restored")} restored, ${numeric(record, "cleaned")} cleaned, ${numeric(record, "failed")} failed, ${numeric(record, "unsupported")} unsupported.`;
  }
  return `Cleanup processed ${numeric(record, "processed")} expired/orphaned transaction(s); ${numeric(record, "remaining")} remain.`;
}

export default defineTool({
  name: "state-transaction",
  title: "Capture, rollback, and clean up bounded live state transactions",
  description:
    "STATE TRANSACTION JOURNAL. Begin a bounded getgenv-backed transaction, capture explicitly requested Instance " +
    "properties/attributes and camera fields, register known cleanup resources, inspect status, commit without " +
    "restoration, or rollback in reverse journal order with pcall-isolated per-item results. Cleanup can rollback or " +
    "explicitly discard expired and cross-place/job orphaned transactions. Registered resources support MCP Drawing " +
    "ids, held virtual input releases, connection state restoration or cleanup-only disconnection, and canonical " +
    "__mcp_hooks/__mcp_hook_meta entries when their metadata is safely understood. This is a best-effort client-state " +
    "journal, not a general undo system: destroyed Instances, fired remotes, server-side changes, arbitrary script " +
    "side effects, and connections destroyed before capture cannot be reconstructed. Commit intentionally discards " +
    "all snapshots and does not clean registered resources.",
  category: "Intelligence",
  mutatesState: true,
  ai: {
    phase: "act",
    prerequisites: [
      "begin a transaction before mutating reversible client state",
      "capture every property/attribute before changing it",
    ],
    consumes: [
      "transaction id or unique name",
      "explicit Instance fields and cleanup resource handles",
    ],
    produces: [
      "bounded state journal",
      "per-item rollback evidence",
      "expired/orphaned cleanup report",
    ],
    verifiesWith: [],
    alternatives: ["set-instance-property", "set-attribute", "camera-control", "restore-hook"],
    requiresCapabilities: ["getgenv"],
    sideEffects: [
      "capture stores raw client references in getgenv until commit, rollback, cleanup, expiry, or executor shutdown",
      "rollback writes captured values and runs registered cleanup actions in reverse order",
      "connection disconnect cleanup is irreversible and is reported separately from reversible restoration",
    ],
    failureRecovery: [
      "inspect every failed or unsupported rollback item and use its dedicated cleanup tool",
      "never assume destroyed Instances, remotes, server state, or arbitrary side effects were restored",
      "run cleanup again after reconnect only when the original client registry still exists",
    ],
  },
  input: z.object({
    action: z.enum(ACTIONS).describe("Transaction lifecycle action."),
    transactionId: z
      .string()
      .min(1)
      .max(96)
      .optional()
      .describe(
        "Stable transaction id. Optional for begin (one is generated); required by id for unambiguous later actions.",
      ),
    name: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Human label; later actions may use it only when exactly one active transaction matches.",
      ),
    targets: z
      .array(targetSchema)
      .max(16)
      .optional()
      .default([])
      .describe("Explicit property/attribute snapshot targets for begin or capture."),
    captureCamera: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Snapshot CurrentCamera CameraType, CameraSubject, CFrame, Focus, and FieldOfView.",
      ),
    cleanupItems: z
      .array(cleanupItemSchema)
      .max(64)
      .optional()
      .default([])
      .describe("Resources to release/restore during reverse-order rollback."),
    maxItems: z
      .number()
      .int()
      .positive()
      .max(MAX_ITEMS)
      .optional()
      .describe(
        `Per-transaction journal cap (default ${DEFAULT_ITEMS}, hard maximum ${MAX_ITEMS}); for capture it may only lower the call cap.`,
      ),
    expirySeconds: z
      .number()
      .int()
      .min(10)
      .max(86_400)
      .optional()
      .describe(
        `Seconds until cleanup considers the transaction expired (default ${DEFAULT_EXPIRY_SECONDS} on begin). Capture may refresh it.`,
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_TRANSACTIONS)
      .optional()
      .default(16)
      .describe("Maximum transactions listed or processed by status/cleanup."),
    cleanupMode: z
      .enum(["rollback", "discard"])
      .optional()
      .default("rollback")
      .describe(
        "For cleanup, rollback attempts every journal item first; discard explicitly removes journals without restoration.",
      ),
    includeOrphans: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "For cleanup, include transactions created in another PlaceId/JobId, not only expired ones.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute(
    {
      action,
      transactionId,
      name,
      targets,
      captureCamera,
      cleanupItems,
      maxItems,
      expirySeconds,
      limit,
      cleanupMode,
      includeOrphans,
      threadContext,
    },
    ctx,
  ) {
    if (["capture", "commit", "rollback"].includes(action) && !transactionId && !name) {
      return {
        data: { error: `${action} requires transactionId or a unique name.` },
        summary: `${action} requires transactionId or a unique name.`,
        isError: true,
      };
    }

    for (const item of cleanupItems) {
      if (
        item.kind === "virtual-input" &&
        (item.inputType === "key" || item.inputType === "gamepad-button") &&
        !item.key
      ) {
        return {
          data: { error: `${item.inputType} cleanup requires key.` },
          summary: `${item.inputType} cleanup requires key.`,
          isError: true,
        };
      }
      if (
        item.kind === "virtual-input" &&
        (item.inputType === "mouse-button" || item.inputType === "touch") &&
        (item.x === undefined || item.y === undefined)
      ) {
        return {
          data: { error: `${item.inputType} cleanup requires x and y.` },
          summary: `${item.inputType} cleanup requires x and y.`,
          isError: true,
        };
      }
    }

    const requestedItems =
      targets.reduce(
        (count, target) => count + target.properties.length + target.attributes.length,
        0,
      ) +
      (captureCamera ? 5 : 0) +
      cleanupItems.length;
    if (requestedItems > MAX_ITEMS) {
      return {
        data: {
          error: `Capture requests ${requestedItems} items; hard per-call maximum is ${MAX_ITEMS}.`,
          requestedItems,
          maxItems: MAX_ITEMS,
        },
        summary: `Capture request exceeds the ${MAX_ITEMS}-item safety cap.`,
        isError: true,
      };
    }

    const source = `
${PRELUDE}
${RESOLVE_PRELUDE}
local ACTION = ${q(action)}
local REQUESTED_ID = ${q(transactionId ?? "")}
local REQUESTED_NAME = ${q(name ?? "")}
local CAPTURE_TARGETS = ${targetsLiteral(targets)}
local CAPTURE_CAMERA = ${captureCamera ? "true" : "false"}
local CLEANUP_ITEMS = ${cleanupItemsLiteral(cleanupItems)}
local REQUESTED_MAX_ITEMS = ${maxItems === undefined ? "nil" : String(maxItems)}
local REQUESTED_EXPIRY = ${expirySeconds === undefined ? "nil" : String(expirySeconds)}
local TRANSACTION_LIMIT = ${String(limit)}
local CLEANUP_MODE = ${q(cleanupMode)}
local INCLUDE_ORPHANS = ${includeOrphans ? "true" : "false"}
local MAX_TRANSACTIONS = ${MAX_TRANSACTIONS}
local HARD_MAX_ITEMS = ${MAX_ITEMS}
local DEFAULT_MAX_ITEMS = ${DEFAULT_ITEMS}
local DEFAULT_EXPIRY = ${DEFAULT_EXPIRY_SECONDS}
local MAX_CLEANUP_WORK = ${MAX_CLEANUP_WORK}

local LIMITATIONS = {
  "Only explicitly captured properties, attributes, camera fields, and registered cleanup resources are handled.",
  "Destroyed Instances, fired remotes, server-side changes, arbitrary script effects, and already-destroyed connections cannot be reconstructed.",
  "Drawing removal and registered connection disconnection are cleanup-only operations, not reversible snapshots.",
}

if type(getgenv) ~= "function" then
  return { error = "getgenv is unavailable; persistent state transactions are unsupported.", limitations = LIMITATIONS }
end
local okEnv, genv = pcall(getgenv)
if not okEnv or type(genv) ~= "table" then
  return { error = "getgenv did not return a writable table.", limitations = LIMITATIONS }
end

local REGISTRY_KEY = "__mcp_state_transactions"
local registry = genv[REGISTRY_KEY]
if registry == nil then
  registry = { version = 1, counter = 0, transactions = {} }
  genv[REGISTRY_KEY] = registry
elseif type(registry) ~= "table" then
  return { error = REGISTRY_KEY .. " exists but is not a table; refusing to overwrite unknown state.", limitations = LIMITATIONS }
elseif registry.version ~= 1 then
  return { error = "Unsupported state transaction registry version: " .. tostring(registry.version), limitations = LIMITATIONS }
end
if type(registry.transactions) ~= "table" then
  return { error = "State transaction registry is corrupt (transactions is not a table).", limitations = LIMITATIONS }
end
if type(registry.counter) ~= "number" then registry.counter = 0 end

local function now()
  local ok, value = pcall(function() return os.time() end)
  if ok and type(value) == "number" then return value end
  local okClock, clock = pcall(function() return os.clock() end)
  return okClock and math.floor(clock) or 0
end

local function currentOwner()
  local placeId = 0
  local jobId = ""
  pcall(function() placeId = game.PlaceId end)
  pcall(function() jobId = game.JobId end)
  return placeId, jobId
end

local function countTransactions()
  local count = 0
  for _ in pairs(registry.transactions) do count = count + 1 end
  return count
end

local function isOrphaned(tx)
  if type(tx) ~= "table" then return true, "invalid-entry" end
  local placeId, jobId = currentOwner()
  if type(tx.ownerPlaceId) == "number" and tx.ownerPlaceId ~= 0 and placeId ~= 0 and tx.ownerPlaceId ~= placeId then
    return true, "place-changed"
  end
  if type(tx.ownerJobId) == "string" and tx.ownerJobId ~= "" and jobId ~= "" and tx.ownerJobId ~= jobId then
    return true, "job-changed"
  end
  return false, nil
end

local function isExpired(tx, timestamp)
  return type(tx) == "table" and type(tx.expiresAt) == "number" and tx.expiresAt <= timestamp
end

local function resolveTransaction()
  if REQUESTED_ID ~= "" then
    local tx = registry.transactions[REQUESTED_ID]
    if type(tx) ~= "table" then return nil, nil, "Unknown transaction id '" .. REQUESTED_ID .. "'." end
    return tx, REQUESTED_ID, nil
  end
  if REQUESTED_NAME == "" then return nil, nil, "Provide transactionId or name." end
  local match, matchId, matches = nil, nil, 0
  for id, tx in pairs(registry.transactions) do
    if type(tx) == "table" and tx.name == REQUESTED_NAME then
      match, matchId, matches = tx, tostring(id), matches + 1
    end
  end
  if matches == 0 then return nil, nil, "No transaction named '" .. REQUESTED_NAME .. "'." end
  if matches > 1 then return nil, nil, "Transaction name '" .. REQUESTED_NAME .. "' is ambiguous; use transactionId." end
  return match, matchId, nil
end

local function evaluate(expression)
  local loader = loadstring or load
  if type(loader) ~= "function" then return nil, "loadstring/load is unavailable" end
  local okCompile, chunkOrErr = pcall(loader, "return " .. expression)
  if not okCompile or type(chunkOrErr) ~= "function" then
    return nil, "compile failed: " .. tostring(chunkOrErr)
  end
  local okRun, value = pcall(chunkOrErr)
  if not okRun then return nil, "evaluation failed: " .. tostring(value) end
  return value, nil
end

local function pathOf(instance)
  local ok, value = pcall(function() return instance:GetFullName() end)
  return ok and value or tostring(instance)
end

local function describeItem(item, index)
  local out = {
    index = index,
    kind = type(item) == "table" and item.kind or "invalid",
    reversible = type(item) == "table" and item.reversible == true or false,
    operation = type(item) == "table" and item.operation or "unknown",
  }
  if type(item) ~= "table" then return out end
  out.path = item.path
  out.property = item.property
  out.attribute = item.attribute
  out.cameraProperty = item.cameraProperty
  out.drawingId = item.drawingId
  out.inputType = item.inputType
  out.connectionAction = item.connectionAction
  out.hookKey = item.hookKey
  return out
end

local function itemResult(index, item, status, message)
  local out = describeItem(item, index)
  out.status = status
  out.message = message
  return out
end

local function invokeNative(fn)
  local callable = fn
  if type(newcclosure) == "function" then
    local okWrap, wrapped = pcall(newcclosure, fn)
    if okWrap and type(wrapped) == "function" then callable = wrapped end
  end
  return pcall(callable)
end

local function enumItem(enumType, name)
  local ok, item = pcall(function() return enumType[name] end)
  if not ok or typeof(item) ~= "EnumItem" then return nil end
  return item
end

local function restoreHook(item, index)
  if type(item.original) ~= "function" then
    return itemResult(index, item, "unsupported", "Captured hook original is unavailable.")
  end
  if item.hookKind == "function" then
    local target, targetErr = evaluate(item.targetExpression)
    if targetErr or type(target) ~= "function" then
      return itemResult(index, item, "failed", "Could not re-resolve hooked function: " .. tostring(targetErr or typeof(target)))
    end
    local restored, restoreErr = false, nil
    if type(restorefunction) == "function" then
      restored, restoreErr = pcall(restorefunction, target)
    end
    if not restored and type(hookfunction) == "function" then
      restored, restoreErr = pcall(hookfunction, target, item.original)
    end
    if not restored then
      local status = type(restorefunction) ~= "function" and type(hookfunction) ~= "function" and "unsupported" or "failed"
      return itemResult(index, item, status, "Hook restoration failed: " .. tostring(restoreErr or "no restoration API"))
    end
  elseif item.hookKind == "metamethod" then
    if type(hookmetamethod) ~= "function" then
      return itemResult(index, item, "unsupported", "hookmetamethod is unavailable.")
    end
    local object, objectErr = evaluate(item.targetExpression)
    if objectErr or object == nil then
      return itemResult(index, item, "failed", "Could not re-resolve metamethod object: " .. tostring(objectErr))
    end
    local ok, err = pcall(hookmetamethod, object, item.method, item.original)
    if not ok then return itemResult(index, item, "failed", "Metamethod restoration failed: " .. tostring(err)) end
  else
    return itemResult(index, item, "unsupported", "Unknown canonical MCP hook metadata kind.")
  end

  local hooks = genv.__mcp_hooks
  local metadata = genv.__mcp_hook_meta
  if type(hooks) == "table" and hooks[item.hookKey] == item.original then hooks[item.hookKey] = nil end
  if type(metadata) == "table" then metadata[item.hookKey] = nil end
  return itemResult(index, item, "restored", "Canonical MCP hook restored.")
end

local function releaseVirtualInput(item, index)
  local okService, vim = pcall(function() return game:GetService("VirtualInputManager") end)
  if not okService or typeof(vim) ~= "Instance" then vim = nil end
  local kind = item.inputType
  local ok, err
  if kind == "key" then
    local keyCode = enumItem(Enum.KeyCode, item.key)
    if not keyCode then return itemResult(index, item, "unsupported", "Unknown Enum.KeyCode '" .. tostring(item.key) .. "'.") end
    if vim then
      ok, err = invokeNative(function() vim:SendKeyEvent(false, keyCode, false, game) end)
    elseif #item.key == 1 and type(keyrelease) == "function" then
      ok, err = invokeNative(function() keyrelease(string.byte(string.upper(item.key))) end)
    else
      return itemResult(index, item, "unsupported", "No compatible key-release API is available.")
    end
  elseif kind == "mouse-button" then
    local ids = { Left = 0, Right = 1, Middle = 2 }
    local id = ids[item.button]
    if id == nil then return itemResult(index, item, "unsupported", "Unknown mouse button.") end
    if vim then
      ok, err = invokeNative(function() vim:SendMouseButtonEvent(item.x, item.y, id, false, game, 0) end)
    else
      local fallback = ({ Left = mouse1release, Right = mouse2release, Middle = mouse3release })[item.button]
      if type(fallback) ~= "function" then
        return itemResult(index, item, "unsupported", "No compatible mouse-release API is available.")
      end
      ok, err = invokeNative(fallback)
    end
  elseif kind == "touch" then
    if not vim then return itemResult(index, item, "unsupported", "Touch release requires VirtualInputManager.") end
    ok, err = invokeNative(function() vim:SendTouchEvent(item.touchId, Enum.UserInputState.End, item.x, item.y, game) end)
  elseif kind == "gamepad-button" then
    if not vim then return itemResult(index, item, "unsupported", "Gamepad release requires VirtualInputManager.") end
    local inputType = enumItem(Enum.UserInputType, item.gamepad)
    local keyCode = enumItem(Enum.KeyCode, item.key)
    if not inputType or not keyCode then
      return itemResult(index, item, "unsupported", "Unknown gamepad or Enum.KeyCode value.")
    end
    ok, err = invokeNative(function() vim:SendGamepadButtonEvent(inputType, keyCode, false, game) end)
  else
    return itemResult(index, item, "unsupported", "Unknown virtual input cleanup type.")
  end
  if not ok then return itemResult(index, item, "failed", "Input release failed: " .. tostring(err)) end
  return itemResult(index, item, "cleaned", "Held virtual input released.")
end

local function restoreItem(item, index)
  if type(item) ~= "table" then return itemResult(index, item, "unsupported", "Invalid journal item.") end
  if item.kind == "instance-property" then
    if typeof(item.instance) ~= "Instance" then return itemResult(index, item, "failed", "Captured Instance reference is no longer valid.") end
    local ok, err = pcall(function() item.instance[item.property] = item.value end)
    if not ok then return itemResult(index, item, "failed", "Property restore failed: " .. tostring(err)) end
    return itemResult(index, item, "restored", "Instance property restored.")
  elseif item.kind == "instance-attribute" then
    if typeof(item.instance) ~= "Instance" then return itemResult(index, item, "failed", "Captured Instance reference is no longer valid.") end
    local ok, err = pcall(function()
      item.instance:SetAttribute(item.attribute, item.hadValue and item.value or nil)
    end)
    if not ok then return itemResult(index, item, "failed", "Attribute restore failed: " .. tostring(err)) end
    return itemResult(index, item, "restored", item.hadValue and "Attribute value restored." or "Attribute absence restored.")
  elseif item.kind == "camera-property" then
    if typeof(item.camera) ~= "Instance" then return itemResult(index, item, "failed", "Captured Camera reference is no longer valid.") end
    local ok, err = pcall(function() item.camera[item.cameraProperty] = item.value end)
    if not ok then return itemResult(index, item, "failed", "Camera field restore failed: " .. tostring(err)) end
    return itemResult(index, item, "restored", "Camera field restored.")
  elseif item.kind == "drawing" then
    local handle = item.handle
    local drawings = genv.__mcp_drawings
    if handle == nil and type(drawings) == "table" and type(drawings[item.drawingId]) == "table" then
      handle = drawings[item.drawingId].handle
    end
    if handle == nil then return itemResult(index, item, "unsupported", "Drawing handle is absent from the MCP registry.") end
    local ok, err = pcall(function() handle:Remove() end)
    if not ok then return itemResult(index, item, "failed", "Drawing Remove() failed: " .. tostring(err)) end
    if type(drawings) == "table" and type(drawings[item.drawingId]) == "table" and drawings[item.drawingId].handle == handle then
      drawings[item.drawingId] = nil
    end
    return itemResult(index, item, "cleaned", "Registered Drawing removed; this cleanup item is not a reversible snapshot.")
  elseif item.kind == "virtual-input" then
    return releaseVirtualInput(item, index)
  elseif item.kind == "connection" then
    if item.connection == nil then return itemResult(index, item, "failed", "Captured connection reference is unavailable.") end
    if item.connectionAction == "restore-state" then
      local ok, err = pcall(function()
        if item.wasEnabled then item.connection:Enable() else item.connection:Disable() end
      end)
      if not ok then return itemResult(index, item, "failed", "Connection state restore failed: " .. tostring(err)) end
      return itemResult(index, item, "restored", "Connection Enabled state restored.")
    elseif item.connectionAction == "disconnect" then
      local ok, err = pcall(function() item.connection:Disconnect() end)
      if not ok then return itemResult(index, item, "failed", "Registered connection disconnect failed: " .. tostring(err)) end
      return itemResult(index, item, "cleaned", "Registered connection disconnected; disconnected connections cannot be recreated.")
    end
    return itemResult(index, item, "unsupported", "Unknown connection rollback action.")
  elseif item.kind == "mcp-hook" then
    return restoreHook(item, index)
  end
  return itemResult(index, item, "unsupported", "Unknown journal item kind '" .. tostring(item.kind) .. "'.")
end

local function rollbackTransaction(id, tx, reason)
  local results = {}
  local restored, cleaned, failed, unsupported = 0, 0, 0, 0
  local items = type(tx.items) == "table" and tx.items or {}
  for index = #items, 1, -1 do
    local ok, result = pcall(restoreItem, items[index], index)
    if not ok then
      result = itemResult(index, items[index], "failed", "Rollback handler threw: " .. tostring(result))
    end
    results[#results + 1] = result
    if result.status == "restored" then restored = restored + 1
    elseif result.status == "cleaned" then cleaned = cleaned + 1
    elseif result.status == "unsupported" then unsupported = unsupported + 1
    else failed = failed + 1 end
  end
  registry.transactions[id] = nil
  return {
    status = (failed + unsupported > 0) and "rollback-incomplete" or "rolled-back",
    transactionId = id,
    name = tx.name,
    reason = reason,
    reverseOrder = true,
    restored = restored,
    cleaned = cleaned,
    failed = failed,
    unsupported = unsupported,
    results = results,
    transactionRemoved = true,
    limitations = LIMITATIONS,
  }
end

local function registerCapture(tx)
  local report = { requested = 0, captured = 0, failed = 0, unsupported = 0, results = {}, truncated = false }
  local transactionCap = math.min(tonumber(tx.maxItems) or DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS)
  local callCap = REQUESTED_MAX_ITEMS and math.min(REQUESTED_MAX_ITEMS, transactionCap) or transactionCap
  if type(tx.items) ~= "table" then tx.items = {} end

  local function reportResult(status, descriptor, message, value)
    local result = descriptor
    result.status = status
    result.message = message
    if value ~= nil then result.value = __encode(value) end
    report.results[#report.results + 1] = result
    if status == "captured" then report.captured = report.captured + 1
    elseif status == "unsupported" then report.unsupported = report.unsupported + 1
    else report.failed = report.failed + 1 end
  end

  local function add(item, descriptor, value)
    report.requested = report.requested + 1
    if #tx.items >= callCap then
      report.truncated = true
      reportResult("unsupported", descriptor, "Journal item cap reached; request was not captured.")
      return false
    end
    tx.items[#tx.items + 1] = item
    reportResult("captured", descriptor, "Captured.", value)
    return true
  end

  for _, target in ipairs(CAPTURE_TARGETS) do
    local instance, resolveErr = __resolve(target.path)
    if not instance then
      report.requested = report.requested + #target.properties + #target.attributes
      report.failed = report.failed + #target.properties + #target.attributes
      report.results[#report.results + 1] = {
        kind = "target",
        path = target.path,
        status = "failed",
        requestedFields = #target.properties + #target.attributes,
        message = "Target resolution failed: " .. tostring(resolveErr),
      }
    else
      for _, property in ipairs(target.properties) do
        local descriptor = { kind = "instance-property", path = target.path, property = property, reversible = true }
        local ok, value = pcall(function() return instance[property] end)
        if not ok then
          report.requested = report.requested + 1
          reportResult("failed", descriptor, "Property read failed: " .. tostring(value))
        else
          add({
            kind = "instance-property",
            reversible = true,
            operation = "restore",
            instance = instance,
            path = target.path,
            property = property,
            value = value,
          }, descriptor, value)
        end
      end
      for _, attribute in ipairs(target.attributes) do
        local descriptor = { kind = "instance-attribute", path = target.path, attribute = attribute, reversible = true }
        local ok, value = pcall(function() return instance:GetAttribute(attribute) end)
        if not ok then
          report.requested = report.requested + 1
          reportResult("failed", descriptor, "Attribute read failed: " .. tostring(value))
        else
          add({
            kind = "instance-attribute",
            reversible = true,
            operation = "restore",
            instance = instance,
            path = target.path,
            attribute = attribute,
            hadValue = value ~= nil,
            value = value,
          }, descriptor, value)
        end
      end
    end
  end

  if CAPTURE_CAMERA then
    local camera = nil
    pcall(function() camera = workspace.CurrentCamera end)
    if typeof(camera) ~= "Instance" then
      report.requested = report.requested + 5
      report.failed = report.failed + 5
      report.results[#report.results + 1] = { kind = "camera", status = "failed", requestedFields = 5, message = "workspace.CurrentCamera is unavailable." }
    else
      local cameraFields = { "CameraType", "CameraSubject", "CFrame", "Focus", "FieldOfView" }
      for _, property in ipairs(cameraFields) do
        local descriptor = { kind = "camera-property", cameraProperty = property, reversible = true }
        local ok, value = pcall(function() return camera[property] end)
        if not ok then
          report.requested = report.requested + 1
          reportResult("failed", descriptor, "Camera field read failed: " .. tostring(value))
        else
          add({
            kind = "camera-property",
            reversible = true,
            operation = "restore",
            camera = camera,
            cameraProperty = property,
            value = value,
          }, descriptor, value)
        end
      end
    end
  end

  for _, cleanup in ipairs(CLEANUP_ITEMS) do
    if cleanup.kind == "drawing" then
      local drawings = genv.__mcp_drawings
      local entry = type(drawings) == "table" and drawings[cleanup.id] or nil
      local descriptor = { kind = "drawing", drawingId = cleanup.id, reversible = false, operation = "cleanup" }
      if type(entry) ~= "table" or entry.handle == nil then
        report.requested = report.requested + 1
        reportResult("unsupported", descriptor, "Drawing id is absent from __mcp_drawings.")
      else
        add({ kind = "drawing", reversible = false, operation = "cleanup", drawingId = cleanup.id, handle = entry.handle }, descriptor)
      end
    elseif cleanup.kind == "virtual-input" then
      local descriptor = { kind = "virtual-input", inputType = cleanup.inputType, reversible = false, operation = "cleanup" }
      add({
        kind = "virtual-input",
        reversible = false,
        operation = "cleanup",
        inputType = cleanup.inputType,
        key = cleanup.key,
        button = cleanup.button,
        x = cleanup.x,
        y = cleanup.y,
        touchId = cleanup.touchId,
        gamepad = cleanup.gamepad,
      }, descriptor)
    elseif cleanup.kind == "connection" then
      local descriptor = { kind = "connection", connectionAction = cleanup.rollbackAction, reversible = cleanup.rollbackAction == "restore-state", operation = cleanup.rollbackAction == "restore-state" and "restore" or "cleanup" }
      local connection, connectionErr = evaluate(cleanup.expression)
      if connectionErr or connection == nil then
        report.requested = report.requested + 1
        reportResult("failed", descriptor, "Connection resolution failed: " .. tostring(connectionErr))
      elseif cleanup.rollbackAction == "restore-state" then
        local okEnabled, enabled = pcall(function() return connection.Enabled end)
        local okMethod, method = pcall(function() return enabled and connection.Enable or connection.Disable end)
        if not okEnabled or type(enabled) ~= "boolean" or not okMethod or type(method) ~= "function" then
          report.requested = report.requested + 1
          reportResult("unsupported", descriptor, "Connection does not expose readable Enabled plus Enable/Disable methods.")
        else
          add({ kind = "connection", reversible = true, operation = "restore", connection = connection, connectionAction = "restore-state", wasEnabled = enabled }, descriptor, enabled)
        end
      else
        local okMethod, method = pcall(function() return connection.Disconnect end)
        if not okMethod or type(method) ~= "function" then
          report.requested = report.requested + 1
          reportResult("unsupported", descriptor, "Connection does not expose Disconnect().")
        else
          add({ kind = "connection", reversible = false, operation = "cleanup", connection = connection, connectionAction = "disconnect" }, descriptor)
        end
      end
    elseif cleanup.kind == "hook" then
      local descriptor = { kind = "mcp-hook", hookKey = cleanup.key, reversible = true, operation = "restore" }
      local hooks, metadata = genv.__mcp_hooks, genv.__mcp_hook_meta
      local original = type(hooks) == "table" and hooks[cleanup.key] or nil
      local meta = type(metadata) == "table" and metadata[cleanup.key] or nil
      if type(original) ~= "function" or type(meta) ~= "table" then
        report.requested = report.requested + 1
        reportResult("unsupported", descriptor, "Canonical MCP hook original/metadata was not safely detectable.")
      elseif meta.kind ~= "function" and meta.kind ~= "metamethod" then
        report.requested = report.requested + 1
        reportResult("unsupported", descriptor, "Canonical MCP hook metadata kind is unknown.")
      elseif type(meta.targetExpr) ~= "string" or (meta.kind == "metamethod" and type(meta.method) ~= "string") then
        report.requested = report.requested + 1
        reportResult("unsupported", descriptor, "Canonical MCP hook metadata is incomplete.")
      else
        add({
          kind = "mcp-hook",
          reversible = true,
          operation = "restore",
          hookKey = cleanup.key,
          hookKind = meta.kind,
          targetExpression = meta.targetExpr,
          method = meta.method,
          original = original,
        }, descriptor)
      end
    end
  end

  tx.updatedAt = now()
  return report
end

if ACTION == "begin" then
  if countTransactions() >= MAX_TRANSACTIONS then
    return { error = "Transaction registry is full (" .. MAX_TRANSACTIONS .. "); commit/rollback one or run cleanup.", maxTransactions = MAX_TRANSACTIONS, limitations = LIMITATIONS }
  end
  registry.counter = registry.counter + 1
  local id = REQUESTED_ID
  if id == "" then id = "tx-" .. tostring(now()) .. "-" .. tostring(registry.counter) end
  if registry.transactions[id] ~= nil then
    return { error = "Transaction id '" .. id .. "' already exists; refusing to overwrite snapshots.", limitations = LIMITATIONS }
  end
  local timestamp = now()
  local placeId, jobId = currentOwner()
  local tx = {
    id = id,
    name = REQUESTED_NAME ~= "" and REQUESTED_NAME or id,
    state = "active",
    createdAt = timestamp,
    updatedAt = timestamp,
    expiresAt = timestamp + (REQUESTED_EXPIRY or DEFAULT_EXPIRY),
    ownerPlaceId = placeId,
    ownerJobId = jobId,
    maxItems = math.min(REQUESTED_MAX_ITEMS or DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS),
    items = {},
  }
  registry.transactions[id] = tx
  local capture = registerCapture(tx)
  return {
    status = "active",
    transactionId = id,
    name = tx.name,
    createdAt = tx.createdAt,
    expiresAt = tx.expiresAt,
    maxItems = tx.maxItems,
    capture = capture,
    registryCount = countTransactions(),
    limitations = LIMITATIONS,
  }
end

if ACTION == "status" then
  if REQUESTED_ID ~= "" or REQUESTED_NAME ~= "" then
    local tx, id, resolveErr = resolveTransaction()
    if not tx then return { error = resolveErr, limitations = LIMITATIONS } end
    local orphaned, orphanReason = isOrphaned(tx)
    local descriptions = {}
    for index, item in ipairs(tx.items) do descriptions[#descriptions + 1] = describeItem(item, index) end
    return {
      status = tx.state,
      transactionId = id,
      name = tx.name,
      createdAt = tx.createdAt,
      updatedAt = tx.updatedAt,
      expiresAt = tx.expiresAt,
      expired = isExpired(tx, now()),
      orphaned = orphaned,
      orphanReason = orphanReason,
      maxItems = tx.maxItems,
      itemCount = #tx.items,
      items = descriptions,
      count = 1,
      limitations = LIMITATIONS,
    }
  end
  local ids = {}
  for id in pairs(registry.transactions) do ids[#ids + 1] = tostring(id) end
  table.sort(ids)
  local transactions = {}
  local timestamp = now()
  for _, id in ipairs(ids) do
    if #transactions >= TRANSACTION_LIMIT then break end
    local tx = registry.transactions[id]
    if type(tx) == "table" then
      local orphaned, orphanReason = isOrphaned(tx)
      transactions[#transactions + 1] = {
        transactionId = id,
        name = tx.name,
        state = tx.state,
        createdAt = tx.createdAt,
        expiresAt = tx.expiresAt,
        expired = isExpired(tx, timestamp),
        orphaned = orphaned,
        orphanReason = orphanReason,
        itemCount = type(tx.items) == "table" and #tx.items or 0,
      }
    else
      transactions[#transactions + 1] = { transactionId = id, state = "invalid", orphaned = true }
    end
  end
  return { status = "registry", count = #ids, returned = #transactions, truncated = #transactions < #ids, transactions = transactions, maxTransactions = MAX_TRANSACTIONS, limitations = LIMITATIONS }
end

if ACTION == "capture" then
  local tx, id, resolveErr = resolveTransaction()
  if not tx then return { error = resolveErr, limitations = LIMITATIONS } end
  if isExpired(tx, now()) then
    return { error = "Transaction is expired; rollback it or run cleanup instead of adding snapshots.", transactionId = id, limitations = LIMITATIONS }
  end
  local orphaned, orphanReason = isOrphaned(tx)
  if orphaned then
    return { error = "Transaction is orphaned (" .. tostring(orphanReason) .. "); rollback/cleanup it instead of adding snapshots.", transactionId = id, limitations = LIMITATIONS }
  end
  if REQUESTED_EXPIRY then tx.expiresAt = now() + REQUESTED_EXPIRY end
  local capture = registerCapture(tx)
  return { status = "active", transactionId = id, name = tx.name, expiresAt = tx.expiresAt, itemCount = #tx.items, capture = capture, limitations = LIMITATIONS }
end

if ACTION == "commit" then
  local tx, id, resolveErr = resolveTransaction()
  if not tx then return { error = resolveErr, limitations = LIMITATIONS } end
  local discarded = type(tx.items) == "table" and #tx.items or 0
  registry.transactions[id] = nil
  return {
    status = "committed",
    transactionId = id,
    name = tx.name,
    discardedItems = discarded,
    restorationAttempted = false,
    warning = "Commit discarded snapshots and cleanup registrations without restoring or releasing them.",
    remaining = countTransactions(),
    limitations = LIMITATIONS,
  }
end

if ACTION == "rollback" then
  local tx, id, resolveErr = resolveTransaction()
  if not tx then return { error = resolveErr, limitations = LIMITATIONS } end
  return rollbackTransaction(id, tx, "explicit")
end

if ACTION == "cleanup" then
  local ids = {}
  if REQUESTED_ID ~= "" or REQUESTED_NAME ~= "" then
    local tx, id, resolveErr = resolveTransaction()
    if not tx then return { error = resolveErr, limitations = LIMITATIONS } end
    ids[1] = id
  else
    for id in pairs(registry.transactions) do ids[#ids + 1] = tostring(id) end
    table.sort(ids)
  end

  local timestamp = now()
  local processed, eligible, work = 0, 0, 0
  local results = {}
  local truncated = false
  for _, id in ipairs(ids) do
    local tx = registry.transactions[id]
    local expired = isExpired(tx, timestamp)
    local orphaned, orphanReason = isOrphaned(tx)
    if expired or (INCLUDE_ORPHANS and orphaned) then
      eligible = eligible + 1
      local itemCount = type(tx) == "table" and type(tx.items) == "table" and #tx.items or 0
      if processed >= TRANSACTION_LIMIT or work + itemCount > MAX_CLEANUP_WORK then
        truncated = true
      else
        processed = processed + 1
        work = work + itemCount
        local reason = expired and "expired" or (orphanReason or "orphaned")
        if CLEANUP_MODE == "rollback" and type(tx) == "table" then
          results[#results + 1] = rollbackTransaction(id, tx, reason)
        else
          registry.transactions[id] = nil
          results[#results + 1] = {
            status = "discarded",
            transactionId = id,
            reason = reason,
            discardedItems = itemCount,
            restorationAttempted = false,
          }
        end
      end
    end
  end
  return {
    status = "cleanup-complete",
    mode = CLEANUP_MODE,
    processed = processed,
    eligible = eligible,
    workItems = work,
    workLimit = MAX_CLEANUP_WORK,
    truncated = truncated,
    results = results,
    remaining = countTransactions(),
    limitations = LIMITATIONS,
  }
end

return { error = "Unknown transaction action.", limitations = LIMITATIONS }
`;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
    const record = recordOf(data);
    const hasError = typeof record?.["error"] === "string";
    const incomplete =
      record?.["status"] === "rollback-incomplete" ||
      (action === "cleanup" &&
        Array.isArray(record?.["results"]) &&
        (record["results"] as unknown[]).some(
          (entry) => recordOf(entry)?.["status"] === "rollback-incomplete",
        ));
    return {
      data,
      summary: resultSummary(action, data),
      ...(hasError || incomplete ? { isError: true } : {}),
    };
  },
});
