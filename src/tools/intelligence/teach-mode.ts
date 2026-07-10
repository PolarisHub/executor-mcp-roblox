import { z } from "zod";
import type { ToolContext, ToolResult } from "../../application/tool/tool.js";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

type UnknownRecord = Record<string, unknown>;

const REMOTE_SPY_TOOL = "trace-remote-traffic";

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function safeToolAvailable(ctx: ToolContext, name: string): boolean {
  try {
    return ctx.tools?.find(name) != null;
  } catch {
    return false;
  }
}

interface RemoteSetup {
  readonly requested: boolean;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly owned: boolean;
  readonly status: string;
  readonly detail?: unknown;
}

async function startRemoteSpy(
  requested: boolean,
  limit: number,
  threadContext: number | undefined,
  ctx: ToolContext,
): Promise<RemoteSetup> {
  if (!requested) {
    return {
      requested: false,
      available: safeToolAvailable(ctx, REMOTE_SPY_TOOL),
      enabled: false,
      owned: false,
      status: "disabled",
    };
  }
  if (!safeToolAvailable(ctx, REMOTE_SPY_TOOL)) {
    return {
      requested: true,
      available: false,
      enabled: false,
      owned: false,
      status: "unavailable",
      detail: "trace-remote-traffic is not registered; core teach-mode recording remains active.",
    };
  }

  try {
    const result = await ctx.invokeTool(REMOTE_SPY_TOOL, {
      action: "start",
      limit,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    const data = asRecord(result.data);
    const error = asString(data?.["error"]);
    if (result.isError === true || error) {
      return {
        requested: true,
        available: true,
        enabled: false,
        owned: false,
        status: "failed",
        detail: error ?? result.data,
      };
    }
    const owned = data?.["started"] === true;
    const shared = data?.["alreadyRunning"] === true;
    return {
      requested: true,
      available: true,
      enabled: owned || shared,
      owned,
      status: owned ? "started" : shared ? "shared-existing" : "unknown-response",
      detail: result.data,
    };
  } catch (error) {
    return {
      requested: true,
      available: true,
      enabled: false,
      owned: false,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const REMOTE_FALLBACK_STOP_LUAU = `
if type(getgenv) ~= "function" then return { restored = false, error = "getgenv unavailable" } end
local state = getgenv().__mcp_remoteTrace
if type(state) ~= "table" then return { restored = true, notRunning = true } end
local restored = false
local restoreError = nil
if type(state.orig) == "function" and type(hookmetamethod) == "function" then
  local ok, err = pcall(hookmetamethod, game, "__namecall", state.orig)
  restored = ok
  if not ok then restoreError = tostring(err) end
end
if (not restored) and type(state.hook) == "function" and type(restorefunction) == "function" then
  local ok, err = pcall(restorefunction, state.hook)
  restored = ok
  if not ok then restoreError = tostring(err) end
end
getgenv().__mcp_remoteTrace = nil
return { restored = restored, restoreError = restoreError, fallback = true }
`;

async function releaseOwnedRemoteSpy(
  owned: boolean,
  threadContext: number | undefined,
  ctx: ToolContext,
): Promise<UnknownRecord> {
  if (!owned) return { released: false, reason: "not-owned" };

  if (safeToolAvailable(ctx, REMOTE_SPY_TOOL)) {
    try {
      const result = await ctx.invokeTool(REMOTE_SPY_TOOL, {
        action: "stop",
        limit: 1,
        ...(threadContext !== undefined ? { threadContext } : {}),
      });
      const data = asRecord(result.data);
      if (result.isError !== true && !asString(data?.["error"])) {
        return { released: true, method: "invokeTool", detail: result.data };
      }
    } catch {
      // Fall through to a direct restoration so a failed nested call cannot leak the hook.
    }
  }

  try {
    const detail = await ctx.runLuau(REMOTE_FALLBACK_STOP_LUAU, {
      threadContext,
      timeoutMs: 15000,
    });
    return { released: true, method: "direct-fallback", detail };
  } catch (error) {
    return {
      released: false,
      method: "direct-fallback",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function fallbackPathExpression(path: string): string {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return path;
  let expression = `game:GetService(${q(segments[0]!)})`;
  for (const segment of segments.slice(1)) {
    expression += `:FindFirstChild(${q(segment)})`;
  }
  return expression;
}

function normalizeRemoteEvents(
  remoteData: unknown,
  startedAt: number,
  sinceRemoteTime: number,
): UnknownRecord[] {
  const record = asRecord(remoteData);
  const rawEntries = Array.isArray(record?.["entries"])
    ? (record["entries"] as unknown[])
    : Array.isArray(record?.["logs"])
      ? (record["logs"] as unknown[])
      : [];

  const events: UnknownRecord[] = [];
  for (const raw of rawEntries) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const absolute = asNumber(entry["t"], -1);
    if (absolute < 0) continue;
    const relative = Math.max(0, absolute - startedAt);
    if (absolute < startedAt || relative <= sinceRemoteTime) continue;
    const remote = asString(entry["remote"]) ?? "<unknown remote>";
    const method = asString(entry["method"]) ?? "Unknown";
    events.push({
      kind: "remote_call",
      source: "remote-spy",
      t: relative,
      remoteId: `remote:${absolute}:${method}:${remote}`,
      target: {
        path: remote,
        expression: fallbackPathExpression(remote),
        className: asString(entry["class"]),
        name: remote.split(".").at(-1),
      },
      method,
      args: Array.isArray(entry["args"] as unknown) ? entry["args"] : [],
      argCount: asNumber(entry["argCount"]),
      argsTruncated: entry["argsTruncated"] === true,
      blocked: entry["blocked"] === true,
    });
  }
  return events.sort((a, b) => asNumber(a["t"]) - asNumber(b["t"]));
}

async function addRemoteTimeline(
  data: unknown,
  remoteLimit: number,
  sinceRemoteTime: number,
  threadContext: number | undefined,
  ctx: ToolContext,
): Promise<UnknownRecord> {
  const record = asRecord(data) ?? { raw: data };
  if (record["remoteSpyEnabled"] !== true) return record;
  if (!safeToolAvailable(ctx, REMOTE_SPY_TOOL)) {
    return {
      ...record,
      remoteSpyIntegration: { status: "unavailable-during-read" },
    };
  }

  try {
    const remoteResult = await ctx.invokeTool(REMOTE_SPY_TOOL, {
      action: "fetch",
      limit: remoteLimit,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    const remoteError = asString(asRecord(remoteResult.data)?.["error"]);
    if (remoteResult.isError === true || remoteError) {
      return {
        ...record,
        remoteSpyIntegration: { status: "read-failed", error: remoteError ?? remoteResult.data },
      };
    }

    const localEvents = Array.isArray(record["events"])
      ? (record["events"] as unknown[]).filter((event) => asRecord(event) !== null)
      : [];
    const startedAt = asNumber(record["startedAt"]);
    const remoteEvents = normalizeRemoteEvents(remoteResult.data, startedAt, sinceRemoteTime);
    const events = [...localEvents, ...remoteEvents].sort(
      (a, b) => asNumber(asRecord(a)?.["t"]) - asNumber(asRecord(b)?.["t"]),
    );
    return {
      ...record,
      events,
      remoteSpyIntegration: {
        status: "captured",
        returned: remoteEvents.length,
        duplicateKey: "remoteId",
        note: "Polls can repeat remote entries; de-duplicate by remoteId or pass sinceRemoteTime.",
      },
    };
  } catch (error) {
    return {
      ...record,
      remoteSpyIntegration: {
        status: "read-failed",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function targetOf(event: UnknownRecord): UnknownRecord | null {
  return asRecord(event["target"]);
}

function eventKey(event: UnknownRecord): string {
  const target = targetOf(event);
  return (
    asString(target?.["expression"]) ??
    asString(target?.["path"]) ??
    `${asString(event["inputType"]) ?? "event"}:${asString(event["keyCode"]) ?? ""}`
  );
}

function toLuau(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return q(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (Array.isArray(value)) return `{ ${value.map(toLuau).join(", ")} }`;
  const record = asRecord(value);
  if (!record) return "nil";
  return `{ ${Object.entries(record)
    .map(([key, item]) => `[${q(key)}] = ${toLuau(item)}`)
    .join(", ")} }`;
}

function buildSourceDraft(steps: readonly UnknownRecord[]): string {
  const lines = [
    "-- REVIEW REQUIRED: teach-mode inferred correlation and ordering, not the user's intent.",
    "-- Validate selectors, timing, guards, and all server-reaching operations before saving or running.",
    "local results = {}",
    "local function guardTarget(expression, expectedClass)",
    "  local loader, loadErr = loadstring(\"return \" .. expression)",
    "  if not loader then return false, loadErr end",
    "  local ok, target = pcall(loader)",
    "  if not ok or typeof(target) ~= \"Instance\" then return false, tostring(target) end",
    "  if expectedClass and expectedClass ~= \"\" and not target:IsA(expectedClass) then",
    "    return false, \"expected \" .. expectedClass .. \", got \" .. target.ClassName",
    "  end",
    "  return true",
    "end",
  ];

  for (const rawStep of steps) {
    const step = asRecord(rawStep)!;
    const id = asString(step["id"]) ?? `step-${lines.length}`;
    const waitMs = Math.max(0, Math.min(5000, Math.round(asNumber(step["waitBeforeMs"]))));
    const candidate = asRecord(step["candidate"]);
    const tool = asString(candidate?.["tool"]);
    const input = asRecord(candidate?.["inputTemplate"]) ?? {};
    const selector = asRecord(step["selector"]);
    const pathPlaceholder = asString(step["pathPlaceholder"]);
    const expectedClass = asString(selector?.["className"]);

    lines.push(`-- ${id}: ${tool ?? "manual observation"}`);
    if (waitMs > 0) lines.push(`task.wait(${(waitMs / 1000).toFixed(3)})`);
    if (pathPlaceholder && expectedClass) {
      lines.push(
        `do local ok, err = guardTarget(${q(pathPlaceholder)}, ${q(expectedClass)}); if not ok then error(${q(
          `${id} guard failed: `,
        )} .. tostring(err)) end end`,
      );
    }
    if (!tool) continue;
    if (tool === "fire-remote") {
      lines.push(
        `-- OMITTED ${id}: fire-remote can affect the server and its captured arguments may be lossy; insert only after manual review.`,
      );
      continue;
    }
    lines.push(`results[${q(id)}] = mcp.call(${q(tool)}, ${toLuau(input)})`);
  }
  lines.push("return { draft = true, results = results }");
  return lines.join("\n");
}

function generatePlaybook(data: UnknownRecord): UnknownRecord {
  const events = (Array.isArray(data["events"]) ? data["events"] : [])
    .map(asRecord)
    .filter((event): event is UnknownRecord => event !== null)
    .sort((a, b) => asNumber(a["t"]) - asNumber(b["t"]));
  const parameters: UnknownRecord[] = [];
  const parameterNames = new Map<string, string>();
  const steps: UnknownRecord[] = [];
  const manualFlags: string[] = [
    "Intent is not inferred perfectly: the draft preserves observed correlation and order only.",
  ];
  const usedEnds = new Set<number>();
  const guiActivationTimes = events
    .filter((event) => event["kind"] === "gui_activated")
    .map((event) => asNumber(event["t"]));
  const visibleTargets = new Map<string, UnknownRecord>();
  let characterReady: UnknownRecord | null = null;
  const equippedTools = new Set<string>();
  let previousActionTime = 0;
  let rawMouseMovementCount = 0;

  const parameter = (
    prefix: string,
    type: string,
    defaultValue: unknown,
    evidence: unknown,
    description: string,
  ): string => {
    const key = `${type}:${String(defaultValue)}`;
    const existing = parameterNames.get(key);
    if (existing) return `\${${existing}}`;
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "") || "value";
    const name = `${safePrefix}_${parameters.length + 1}`;
    parameterNames.set(key, name);
    parameters.push({ name, type, default: defaultValue, evidence, description });
    return `\${${name}}`;
  };

  const inferredGuards = (event: UnknownRecord, selector: UnknownRecord | null): UnknownRecord[] => {
    const guards: UnknownRecord[] = [];
    if (selector) {
      guards.push({
        type: "target-exists",
        selector,
        reason: "The demonstrated action referenced this live instance.",
      });
      const visible = visibleTargets.get(eventKey(event));
      if (visible) {
        guards.push({
          type: "target-visible",
          evidenceSeq: visible["seq"],
          reason: "The target appeared before the action in the demonstration.",
        });
      }
    }
    if (characterReady) {
      guards.push({
        type: "character-ready",
        evidenceSeq: characterReady["seq"],
        reason: "A character-ready/respawn event preceded this action.",
      });
    }
    if (equippedTools.size > 0) {
      guards.push({
        type: "tool-equipped",
        names: [...equippedTools],
        reason: "These tools were equipped at this point in the observed ordering.",
      });
    }
    return guards;
  };

  const addStep = (
    event: UnknownRecord,
    tool: string,
    inputTemplate: UnknownRecord,
    confidence: "low" | "medium" | "high",
    flags: readonly string[],
    pathPlaceholder?: string,
  ) => {
    const t = asNumber(event["t"]);
    const selector = targetOf(event);
    const observedGap = Math.max(0, t - previousActionTime);
    const waitBeforeMs = Math.min(5000, Math.max(0, Math.round(observedGap * 1000 - 50)));
    previousActionTime = t;
    steps.push({
      id: `step-${steps.length + 1}`,
      observedAtSec: t,
      waitBeforeMs,
      waitEvidence: {
        observedGapMs: Math.round(observedGap * 1000),
        note: "Capped ordering delay; user think-time is not treated as required timing.",
      },
      guards: inferredGuards(event, selector),
      candidate: { tool, inputTemplate },
      selector,
      ...(pathPlaceholder ? { pathPlaceholder } : {}),
      confidence,
      uncertainty: flags,
      manualReview: flags.length > 0,
      evidence: {
        eventKind: event["kind"],
        seq: event["seq"],
        remoteId: event["remoteId"],
      },
    });
    manualFlags.push(...flags);
  };

  const targetParameter = (event: UnknownRecord, prefix: string): string | undefined => {
    const selector = targetOf(event);
    const expression = asString(selector?.["expression"]) ?? asString(selector?.["path"]);
    if (!expression || !selector) return undefined;
    return parameter(
      prefix,
      "LuauInstanceExpression",
      expression,
      selector,
      "Re-resolve this semantic target in the current game before execution.",
    );
  };

  const findMatchingEnd = (startIndex: number, start: UnknownRecord): number | undefined => {
    const inputId = asNumber(start["inputId"], -1);
    const inputType = asString(start["inputType"]);
    const keyCode = asString(start["keyCode"]);
    const startTime = asNumber(start["t"]);
    for (let index = startIndex + 1; index < events.length; index += 1) {
      const candidate = events[index]!;
      if (asNumber(candidate["t"]) - startTime > 10) break;
      if (candidate["kind"] === "input_began" && eventKey(candidate) === eventKey(start)) break;
      if (candidate["kind"] !== "input_ended") continue;
      const idMatches = inputId >= 0 && asNumber(candidate["inputId"], -2) === inputId;
      const shapeMatches =
        asString(candidate["inputType"]) === inputType &&
        asString(candidate["keyCode"]) === keyCode;
      if ((idMatches || shapeMatches) && !usedEnds.has(index)) return index;
    }
    return undefined;
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const kind = asString(event["kind"]) ?? "unknown";
    if (kind === "character_ready" || kind === "character_respawned") {
      characterReady = event;
      continue;
    }
    if (kind === "character_removing") {
      characterReady = null;
      equippedTools.clear();
      continue;
    }
    if (kind === "gui_appeared") {
      visibleTargets.set(eventKey(event), event);
      continue;
    }
    if (kind === "gui_disappeared") {
      visibleTargets.delete(eventKey(event));
      continue;
    }
    if (kind === "tool_equipped") {
      const name = asString(targetOf(event)?.["name"]);
      if (name) equippedTools.add(name);
      continue;
    }
    if (kind === "tool_unequipped") {
      const name = asString(targetOf(event)?.["name"]);
      if (name) equippedTools.delete(name);
      continue;
    }

    if (kind === "gui_activated") {
      const path = targetParameter(event, "button_path");
      if (path) {
        addStep(
          event,
          "click-button",
          { path, action: "Activated" },
          "medium",
          ["Activated proves the button fired, but does not prove why the user chose it."],
          path,
        );
      }
      continue;
    }

    if (kind === "proximity_triggered") {
      const path = targetParameter(event, "prompt_path");
      if (path) {
        addStep(
          event,
          "fire-proximity-prompt",
          { path },
          "medium",
          ["Prompt triggering may have distance, hold-duration, or server-side consequences."],
          path,
        );
      }
      continue;
    }

    if (kind === "remote_call") {
      const path = targetParameter(event, "remote_path");
      if (!path) continue;
      const capturedArgs = Array.isArray(event["args"]) ? (event["args"] as unknown[]) : [];
      const args = capturedArgs.map((arg, argIndex) => {
        if (typeof arg === "string") return { kind: "string", value: arg };
        if (typeof arg === "number") return { kind: "number", value: arg };
        if (typeof arg === "boolean") return { kind: "boolean", value: arg };
        if (arg === null) return { kind: "nil" };
        const encoded = asRecord(arg);
        const observed = encoded?.["path"] ?? encoded?.["value"] ?? arg;
        const placeholder = parameter(
          `remote_arg_${argIndex + 1}`,
          "LuauExpression",
          "nil",
          observed,
          "Non-primitive remote argument was shallow-captured and must be reconstructed manually.",
        );
        return { kind: "raw", value: placeholder };
      });
      const remoteFlags = [
        "Remote replay can mutate server state and is intentionally omitted from the executable source draft.",
        "Remote arguments are shallow observations and may not preserve identity or nested table structure.",
      ];
      if (event["argsTruncated"] === true) remoteFlags.push("The remote argument list was truncated.");
      addStep(
        event,
        "fire-remote",
        {
          remotePath: path,
          mode: asString(event["method"]) ?? "FireServer",
          args,
        },
        "low",
        remoteFlags,
        path,
      );
      continue;
    }

    if (kind === "input_changed" && event["inputType"] === "MouseMovement") {
      rawMouseMovementCount += 1;
      continue;
    }
    if (kind === "input_ended" && usedEnds.has(index)) continue;
    if (kind !== "input_began" && kind !== "input_changed" && kind !== "input_ended") continue;

    const inputType = asString(event["inputType"]) ?? "Unknown";
    const keyCode = asString(event["keyCode"]);
    const matchingEnd = kind === "input_began" ? findMatchingEnd(index, event) : undefined;
    const endEvent = matchingEnd !== undefined ? events[matchingEnd] : undefined;
    if (matchingEnd !== undefined) usedEnds.add(matchingEnd);
    const holdSec = endEvent
      ? Math.max(0, Math.min(10, asNumber(endEvent["t"]) - asNumber(event["t"])))
      : 0;

    if (inputType === "Keyboard" && keyCode && keyCode !== "Unknown" && kind === "input_began") {
      const key = parameter("key", "Enum.KeyCodeName", keyCode, event, "Observed keyboard key.");
      addStep(
        event,
        "virtual-input",
        { action: endEvent ? "keyPress" : "keyDown", key, holdSec },
        "medium",
        endEvent ? [] : ["No matching key-up was retained; review for a potentially held key."],
      );
      continue;
    }

    if (
      (inputType === "MouseButton1" || inputType === "MouseButton2" || inputType === "MouseButton3") &&
      kind === "input_began"
    ) {
      const t = asNumber(event["t"]);
      if (guiActivationTimes.some((activation) => Math.abs(activation - t) <= 0.35)) continue;
      const x = parameter("mouse_x", "number", asNumber(event["x"]), event, "Observed viewport X coordinate.");
      const y = parameter("mouse_y", "number", asNumber(event["y"]), event, "Observed viewport Y coordinate.");
      addStep(
        event,
        "virtual-input",
        {
          action: "mouseButton",
          x,
          y,
          button:
            inputType === "MouseButton2" ? "Right" : inputType === "MouseButton3" ? "Middle" : "Left",
          buttonAction: endEvent ? "click" : "down",
          holdSec,
        },
        "low",
        ["Screen coordinates are resolution/layout dependent; prefer a semantic GUI selector when possible."],
      );
      continue;
    }

    if (inputType === "Touch") {
      const x = parameter("touch_x", "number", asNumber(event["x"]), event, "Observed touch X coordinate.");
      const y = parameter("touch_y", "number", asNumber(event["y"]), event, "Observed touch Y coordinate.");
      addStep(
        event,
        "virtual-input",
        {
          action: "touch",
          x,
          y,
          touchId: asNumber(event["inputId"]),
          touchState: kind === "input_ended" ? "End" : kind === "input_changed" ? "Change" : "Begin",
        },
        "low",
        ["Touch identifiers and coordinates may differ on another device or viewport."],
      );
      continue;
    }

    if (inputType === "MouseWheel" && kind === "input_changed") {
      addStep(
        event,
        "virtual-input",
        { action: "mouseWheel", delta: asNumber(event["wheelDelta"]) },
        "medium",
        ["Wheel delta interpretation can vary with platform and UI focus."],
      );
    }
  }

  if (rawMouseMovementCount > 0) {
    manualFlags.push(
      `${rawMouseMovementCount} throttled mouse-movement event(s) were retained as evidence but omitted from the draft to avoid fragile cursor choreography.`,
    );
  }
  const dropped = asNumber(data["dropped"]);
  if (dropped > 0) manualFlags.push(`${dropped} oldest event(s) were overwritten by the bounded ring buffer.`);
  const stats = asRecord(data["stats"]);
  if (stats?.["guiWatchTruncated"] === true) {
    manualFlags.push("The bounded GUI watcher cap was reached; some UI transitions may be absent.");
  }
  if (stats?.["connectionLimitReached"] === true) {
    manualFlags.push("The listener cap was reached; later dynamic objects may not have been observed.");
  }
  if (steps.length === 0) manualFlags.push("No replay candidate was inferred from the retained events.");

  const finalFlags = unique(manualFlags);
  const defaultParams = Object.fromEntries(
    parameters.map((parameterRecord) => [String(parameterRecord["name"]), parameterRecord["default"]]),
  );
  const highRisk = steps.some(
    (step) => asRecord(step["candidate"])?.["tool"] === "fire-remote" || step["confidence"] === "low",
  );

  return {
    version: 1,
    kind: "teach-mode-conservative-draft",
    sourceSessionId: data["sessionId"],
    reusable: true,
    autoExecutable: false,
    disclaimer:
      "This is a conservative reconstruction of observed events. It does not claim perfect intent inference and must be reviewed before execution.",
    parameters,
    defaultParams,
    steps,
    sourceDraft: buildSourceDraft(steps),
    saveCandidate: {
      tool: "playbook-save",
      inputTemplate: {
        name: "reviewed-teach-mode-demo",
        source: "<sourceDraft after review>",
        params: parameters.map((parameterRecord) => parameterRecord["name"]),
        tags: ["teach-mode", "generated", "review-required"],
      },
    },
    uncertainty: {
      overall: highRisk || dropped > 0 ? "high" : "medium",
      reasons: finalFlags,
    },
    manualReviewRequired: true,
    manualReviewFlags: finalFlags,
  };
}

function buildStartSource(options: {
  readonly requestedSessionId?: string;
  readonly maxEvents: number;
  readonly movementThrottleMs: number;
  readonly expirySeconds: number;
  readonly maxGuiWatch: number;
  readonly remoteSpyEnabled: boolean;
  readonly remoteSpyOwned: boolean;
}): string {
  const requestedId = options.requestedSessionId ? q(options.requestedSessionId) : "nil";
  return `
if type(getgenv) ~= "function" then return { error = "getgenv is required for persistent teach-mode sessions" } end
local genv = getgenv()
local function clock() return os.clock() end

local state = genv.__mcp_teachMode
if type(state) ~= "table" or state.version ~= 1 or type(state.sessions) ~= "table" then
  if type(state) == "table" and type(state.sessions) == "table" then
    for _, oldSession in pairs(state.sessions) do
      if type(oldSession) == "table" and type(oldSession.connections) == "table" then
        for _, connection in ipairs(oldSession.connections) do pcall(function() connection:Disconnect() end) end
      end
    end
  end
  state = { version = 1, sessions = {}, current = nil, serial = 0 }
  genv.__mcp_teachMode = state
end

local function restoreRemoteTrace()
  local trace = genv.__mcp_remoteTrace
  if type(trace) ~= "table" then return true end
  local restored = false
  if type(trace.orig) == "function" and type(hookmetamethod) == "function" then
    restored = pcall(hookmetamethod, game, "__namecall", trace.orig)
  end
  if (not restored) and type(trace.hook) == "function" and type(restorefunction) == "function" then
    restored = pcall(restorefunction, trace.hook)
  end
  genv.__mcp_remoteTrace = nil
  return restored
end

local function transferOrRestoreRemote(session)
  if not session.remoteSpyOwned then return false end
  for _, candidate in pairs(state.sessions) do
    if candidate ~= session and candidate.active and candidate.remoteSpyEnabled then
      candidate.remoteSpyOwned = true
      session.remoteSpyOwned = false
      return false
    end
  end
  session.remoteSpyOwned = false
  restoreRemoteTrace()
  return true
end

local function disconnectSession(session, reason, releaseRemote)
  if type(session) ~= "table" then return 0, 0 end
  session.active = false
  session.stopReason = reason
  session.stoppedAt = clock()
  local disconnected, errors = 0, 0
  for _, connection in ipairs(session.connections or {}) do
    local ok = pcall(function() connection:Disconnect() end)
    if ok then disconnected = disconnected + 1 else errors = errors + 1 end
  end
  session.connections = {}
  if releaseRemote then transferOrRestoreRemote(session) end
  return disconnected, errors
end

local expiredSessions = {}
for id, session in pairs(state.sessions) do
  local expiry = tonumber(session.expirySeconds) or ${options.expirySeconds}
  if (not session.active) or (clock() - (session.lastTouched or session.startedAt or 0) >= expiry) then
    disconnectSession(session, "expired", true)
    state.sessions[id] = nil
    if state.current == id then state.current = nil end
    expiredSessions[#expiredSessions + 1] = id
  end
end

local requestedId = ${requestedId}
if requestedId and state.sessions[requestedId] and state.sessions[requestedId].active then
  return { error = "teach-mode session already exists", sessionId = requestedId, active = true }
end

local activeCount = 0
local oldestId, oldestSession = nil, nil
for id, session in pairs(state.sessions) do
  if session.active then
    activeCount = activeCount + 1
    if not oldestSession or session.startedAt < oldestSession.startedAt then oldestId, oldestSession = id, session end
  end
end
if activeCount >= 3 and oldestSession then
  disconnectSession(oldestSession, "evicted-by-session-cap", true)
  state.sessions[oldestId] = nil
  expiredSessions[#expiredSessions + 1] = oldestId
end

state.serial = (state.serial or 0) + 1
local sessionId = requestedId or ("teach-" .. tostring(math.floor(clock() * 1000)) .. "-" .. tostring(state.serial))
local session = {
  id = sessionId,
  active = true,
  startedAt = clock(),
  lastTouched = clock(),
  expirySeconds = ${options.expirySeconds},
  maxEvents = ${options.maxEvents},
  buffer = {},
  head = 1,
  size = 0,
  seq = 0,
  dropped = 0,
  connections = {},
  connectionCap = math.min(${options.maxGuiWatch} * 2 + 96, 2200),
  movementThrottleSeconds = ${options.movementThrottleMs} / 1000,
  movementLast = {},
  inputIds = setmetatable({}, { __mode = "k" }),
  nextInputId = 0,
  watchedGui = setmetatable({}, { __mode = "k" }),
  maxGuiWatch = ${options.maxGuiWatch},
  guiWatchCount = 0,
  remoteSpyEnabled = ${options.remoteSpyEnabled ? "true" : "false"},
  remoteSpyOwned = ${options.remoteSpyOwned ? "true" : "false"},
  stats = { kindCounts = {}, guiWatchTruncated = false, connectionLimitReached = false },
}
state.sessions[sessionId] = session
state.current = sessionId

local function push(event)
  if not session.active then return end
  local at = clock()
  session.lastTouched = at
  session.seq = session.seq + 1
  event.seq = session.seq
  event.t = math.max(0, at - session.startedAt)
  local index
  if session.size < session.maxEvents then
    index = ((session.head + session.size - 2) % session.maxEvents) + 1
    session.size = session.size + 1
  else
    index = session.head
    session.head = (session.head % session.maxEvents) + 1
    session.dropped = session.dropped + 1
  end
  session.buffer[index] = event
  local kind = tostring(event.kind or "unknown")
  session.stats.kindCounts[kind] = (session.stats.kindCounts[kind] or 0) + 1
end

local function connect(signal, callback)
  if not session.active then return nil end
  if #session.connections >= session.connectionCap then
    if not session.stats.connectionLimitReached then
      session.stats.connectionLimitReached = true
      push({ kind = "listener_limit_reached", cap = session.connectionCap })
    end
    return nil
  end
  local ok, connection = pcall(function() return signal:Connect(callback) end)
  if ok and connection then
    session.connections[#session.connections + 1] = connection
    return connection
  end
  return nil
end

local function selector(instance)
  if typeof(instance) ~= "Instance" then return nil end
  local result = {}
  pcall(function() result.name = instance.Name end)
  pcall(function() result.className = instance.ClassName end)
  pcall(function() result.path = instance:GetFullName() end)

  local hierarchy = {}
  local current = instance
  local truncated = false
  while current and current ~= game do
    if #hierarchy >= 32 then truncated = true break end
    local segment = { name = current.Name, className = current.ClassName }
    table.insert(hierarchy, 1, segment)
    current = current.Parent
  end
  result.hierarchy = hierarchy
  result.hierarchyTruncated = truncated

  if not truncated and current == game and #hierarchy > 0 then
    local root = hierarchy[1]
    local expression
    local okService, service = pcall(function() return game:GetService(root.className) end)
    if okService and service and service.Name == root.name then
      expression = "game:GetService(" .. string.format("%q", root.className) .. ")"
    else
      expression = "game:FindFirstChild(" .. string.format("%q", root.name) .. ")"
    end
    for index = 2, #hierarchy do
      expression = expression .. ":FindFirstChild(" .. string.format("%q", hierarchy[index].name) .. ")"
    end
    result.expression = expression
  end

  pcall(function()
    if instance:IsA("TextLabel") or instance:IsA("TextButton") or instance:IsA("TextBox") then
      result.text = string.sub(instance.Text or "", 1, 160)
    end
  end)
  pcall(function()
    if instance:IsA("GuiObject") then
      result.visible = instance.Visible
      result.absolutePosition = { x = instance.AbsolutePosition.X, y = instance.AbsolutePosition.Y }
      result.absoluteSize = { x = instance.AbsoluteSize.X, y = instance.AbsoluteSize.Y }
    elseif instance:IsA("ScreenGui") then
      result.visible = instance.Enabled
    end
  end)
  pcall(function()
    local collection = game:GetService("CollectionService")
    local tags = collection:GetTags(instance)
    result.tags = {}
    for index = 1, math.min(#tags, 8) do result.tags[index] = tags[index] end
  end)
  pcall(function()
    local all = instance:GetAttributes()
    local attributes, count = {}, 0
    for key, value in pairs(all) do
      local valueType = typeof(value)
      if valueType == "string" or valueType == "number" or valueType == "boolean" then
        attributes[key] = value
        count = count + 1
        if count >= 8 then break end
      end
    end
    result.attributes = attributes
  end)
  return result
end

local function inputSnapshot(input, gameProcessed)
  local inputType, keyCode = "Unknown", "Unknown"
  pcall(function() inputType = input.UserInputType.Name end)
  pcall(function() keyCode = input.KeyCode.Name end)
  local inputId = session.inputIds[input]
  if not inputId then
    session.nextInputId = session.nextInputId + 1
    inputId = session.nextInputId
    session.inputIds[input] = inputId
  end
  local event = {
    inputId = inputId,
    inputType = inputType,
    keyCode = keyCode,
    gameProcessed = gameProcessed == true,
  }
  pcall(function()
    event.x = input.Position.X
    event.y = input.Position.Y
    event.z = input.Position.Z
    if inputType == "MouseWheel" then event.wheelDelta = input.Position.Z end
  end)
  pcall(function()
    event.deltaX = input.Delta.X
    event.deltaY = input.Delta.Y
    event.deltaZ = input.Delta.Z
  end)
  return event
end

local Players = game:GetService("Players")
local UserInputService = game:GetService("UserInputService")
local ProximityPromptService = game:GetService("ProximityPromptService")
local localPlayer = Players.LocalPlayer

connect(UserInputService.InputBegan, function(input, gameProcessed)
  local event = inputSnapshot(input, gameProcessed)
  event.kind = "input_began"
  push(event)
end)
connect(UserInputService.InputEnded, function(input, gameProcessed)
  local event = inputSnapshot(input, gameProcessed)
  event.kind = "input_ended"
  push(event)
end)
connect(UserInputService.InputChanged, function(input)
  local event = inputSnapshot(input, false)
  local moving = event.inputType == "MouseMovement" or event.inputType == "Touch" or string.find(event.inputType, "Gamepad", 1, true) ~= nil
  if moving then
    local last = session.movementLast[event.inputType] or 0
    local at = clock()
    if at - last < session.movementThrottleSeconds then return end
    session.movementLast[event.inputType] = at
  end
  event.kind = "input_changed"
  push(event)
end)

connect(ProximityPromptService.PromptTriggered, function(prompt, playerWhoTriggered)
  push({
    kind = "proximity_triggered",
    target = selector(prompt),
    player = playerWhoTriggered and playerWhoTriggered.Name or nil,
  })
end)

local function relevantGui(instance)
  return instance:IsA("ScreenGui") or instance:IsA("GuiObject")
end

local watchGui
watchGui = function(instance)
  if not session.active or session.watchedGui[instance] or not relevantGui(instance) then return end
  if session.guiWatchCount >= session.maxGuiWatch then
    session.stats.guiWatchTruncated = true
    return
  end
  session.watchedGui[instance] = true
  session.guiWatchCount = session.guiWatchCount + 1

  if instance:IsA("ScreenGui") then
    connect(instance:GetPropertyChangedSignal("Enabled"), function()
      push({ kind = instance.Enabled and "gui_appeared" or "gui_disappeared", target = selector(instance), reason = "Enabled changed" })
    end)
  elseif instance:IsA("GuiObject") then
    connect(instance:GetPropertyChangedSignal("Visible"), function()
      push({ kind = instance.Visible and "gui_appeared" or "gui_disappeared", target = selector(instance), reason = "Visible changed" })
    end)
  end
  if instance:IsA("GuiButton") then
    connect(instance.Activated, function(input)
      local inputType = nil
      pcall(function() inputType = input and input.UserInputType.Name or nil end)
      push({ kind = "gui_activated", target = selector(instance), inputType = inputType })
    end)
  end
end

if localPlayer then
  local playerGui = localPlayer:FindFirstChildOfClass("PlayerGui") or localPlayer:WaitForChild("PlayerGui", 5)
  if playerGui then
    local descendants = playerGui:GetDescendants()
    for _, descendant in ipairs(descendants) do
      if session.guiWatchCount >= session.maxGuiWatch then session.stats.guiWatchTruncated = true break end
      if relevantGui(descendant) then watchGui(descendant) end
    end
    connect(playerGui.DescendantAdded, function(descendant)
      if relevantGui(descendant) then
        push({ kind = "gui_appeared", target = selector(descendant), reason = "DescendantAdded" })
        watchGui(descendant)
      end
    end)
    connect(playerGui.DescendantRemoving, function(descendant)
      if session.watchedGui[descendant] then
        push({ kind = "gui_disappeared", target = selector(descendant), reason = "DescendantRemoving" })
      end
    end)
  end
end

local function watchCharacter(character, reason)
  if not character then return end
  push({ kind = reason == "initial" and "character_ready" or "character_respawned", target = selector(character), reason = reason })
  connect(character.ChildAdded, function(child)
    if child:IsA("Tool") then push({ kind = "tool_equipped", target = selector(child) }) end
  end)
  connect(character.ChildRemoved, function(child)
    if child:IsA("Tool") then push({ kind = "tool_unequipped", target = selector(child) }) end
  end)
  for _, child in ipairs(character:GetChildren()) do
    if child:IsA("Tool") then push({ kind = "tool_equipped", target = selector(child), reason = "initial" }) end
  end
end

if localPlayer then
  connect(localPlayer.CharacterAdded, function(character) watchCharacter(character, "CharacterAdded") end)
  connect(localPlayer.CharacterRemoving, function(character)
    push({ kind = "character_removing", target = selector(character) })
  end)
  watchCharacter(localPlayer.Character, "initial")
  local backpack = localPlayer:FindFirstChildOfClass("Backpack") or localPlayer:FindFirstChild("Backpack")
  if backpack then
    connect(backpack.ChildAdded, function(child)
      if child:IsA("Tool") then push({ kind = "tool_backpack_added", target = selector(child) }) end
    end)
    connect(backpack.ChildRemoved, function(child)
      if child:IsA("Tool") then push({ kind = "tool_backpack_removed", target = selector(child) }) end
    end)
  end
end

push({
  kind = "session_started",
  character = localPlayer and selector(localPlayer.Character) or nil,
  maxEvents = session.maxEvents,
  movementThrottleMs = ${options.movementThrottleMs},
})

local scheduleExpiry
scheduleExpiry = function(delaySeconds)
  task.delay(math.max(1, delaySeconds), function()
    if state.sessions[sessionId] ~= session or not session.active then return end
    local idle = clock() - session.lastTouched
    local remaining = session.expirySeconds - idle
    if remaining <= 0 then
      disconnectSession(session, "expired", true)
      state.sessions[sessionId] = nil
      if state.current == sessionId then state.current = nil end
    else
      scheduleExpiry(remaining)
    end
  end)
end
scheduleExpiry(session.expirySeconds)

return {
  ok = true,
  action = "start",
  sessionId = sessionId,
  active = true,
  startedAt = session.startedAt,
  expiresAfterIdleSeconds = session.expirySeconds,
  maxEvents = session.maxEvents,
  movementThrottleMs = ${options.movementThrottleMs},
  maxGuiWatch = session.maxGuiWatch,
  connectionCap = session.connectionCap,
  connections = #session.connections,
  eventCount = session.size,
  cursor = session.seq,
  expiredSessions = expiredSessions,
  remoteSpyEnabled = session.remoteSpyEnabled,
  remoteSpyOwned = session.remoteSpyOwned,
  stats = session.stats,
}
`;
}

function buildReadSource(options: {
  readonly action: "poll" | "stop" | "cancel";
  readonly requestedSessionId?: string;
  readonly sinceSeq: number;
  readonly limit: number;
}): string {
  const requestedId = options.requestedSessionId ? q(options.requestedSessionId) : "nil";
  return `
if type(getgenv) ~= "function" then return { error = "getgenv is required for persistent teach-mode sessions" } end
local genv = getgenv()
local state = genv.__mcp_teachMode
if type(state) ~= "table" or type(state.sessions) ~= "table" then
  return { error = "no teach-mode session is running", active = false }
end
local function clock() return os.clock() end

local function restoreRemoteTrace()
  local trace = genv.__mcp_remoteTrace
  if type(trace) ~= "table" then return true end
  local restored = false
  if type(trace.orig) == "function" and type(hookmetamethod) == "function" then
    restored = pcall(hookmetamethod, game, "__namecall", trace.orig)
  end
  if (not restored) and type(trace.hook) == "function" and type(restorefunction) == "function" then
    restored = pcall(restorefunction, trace.hook)
  end
  genv.__mcp_remoteTrace = nil
  return restored
end

local function transferOrRestoreRemote(session)
  if not session.remoteSpyOwned then return false end
  for _, candidate in pairs(state.sessions) do
    if candidate ~= session and candidate.active and candidate.remoteSpyEnabled then
      candidate.remoteSpyOwned = true
      session.remoteSpyOwned = false
      return false
    end
  end
  session.remoteSpyOwned = false
  restoreRemoteTrace()
  return true
end

local function disconnectSession(session, reason, releaseRemote)
  session.active = false
  session.stopReason = reason
  session.stoppedAt = clock()
  local disconnected, errors = 0, 0
  for _, connection in ipairs(session.connections or {}) do
    local ok = pcall(function() connection:Disconnect() end)
    if ok then disconnected = disconnected + 1 else errors = errors + 1 end
  end
  session.connections = {}
  if releaseRemote then transferOrRestoreRemote(session) end
  return disconnected, errors
end

local expiredSessions = {}
for id, session in pairs(state.sessions) do
  local expiry = tonumber(session.expirySeconds) or 600
  if (not session.active) or (clock() - (session.lastTouched or session.startedAt or 0) >= expiry) then
    disconnectSession(session, "expired", true)
    state.sessions[id] = nil
    if state.current == id then state.current = nil end
    expiredSessions[#expiredSessions + 1] = id
  end
end

local requestedId = ${requestedId}
local sessionId = requestedId or state.current
local session = sessionId and state.sessions[sessionId] or nil
if type(session) ~= "table" or not session.active then
  return { error = "teach-mode session not found or expired", sessionId = sessionId, active = false, expiredSessions = expiredSessions }
end

local function push(event)
  if not session.active then return end
  local at = clock()
  session.lastTouched = at
  session.seq = session.seq + 1
  event.seq = session.seq
  event.t = math.max(0, at - session.startedAt)
  local index
  if session.size < session.maxEvents then
    index = ((session.head + session.size - 2) % session.maxEvents) + 1
    session.size = session.size + 1
  else
    index = session.head
    session.head = (session.head % session.maxEvents) + 1
    session.dropped = session.dropped + 1
  end
  session.buffer[index] = event
  local kind = tostring(event.kind or "unknown")
  session.stats.kindCounts[kind] = (session.stats.kindCounts[kind] or 0) + 1
end

local function snapshot(sinceSeq, limit)
  local events, eligible, returned, cursor = {}, 0, 0, sinceSeq
  for offset = 0, session.size - 1 do
    local index = ((session.head + offset - 1) % session.maxEvents) + 1
    local event = session.buffer[index]
    if event and (event.seq or 0) > sinceSeq then
      eligible = eligible + 1
      if returned < limit then
        returned = returned + 1
        events[returned] = event
        cursor = math.max(cursor, event.seq or cursor)
      end
    end
  end
  return events, cursor, eligible > returned, eligible
end

local action = ${q(options.action)}
if action == "poll" then
  session.lastTouched = clock()
  local events, cursor, hasMore, eligible = snapshot(${options.sinceSeq}, ${options.limit})
  return {
    ok = true,
    action = action,
    sessionId = sessionId,
    active = true,
    startedAt = session.startedAt,
    elapsedSeconds = clock() - session.startedAt,
    events = events,
    cursor = cursor,
    newestSeq = session.seq,
    hasMore = hasMore,
    eligible = eligible,
    retained = session.size,
    dropped = session.dropped,
    maxEvents = session.maxEvents,
    connections = #session.connections,
    expiredSessions = expiredSessions,
    remoteSpyEnabled = session.remoteSpyEnabled,
    remoteSpyOwned = session.remoteSpyOwned,
    stats = session.stats,
  }
end

local releaseRemote = session.remoteSpyOwned == true
if releaseRemote then
  for _, candidate in pairs(state.sessions) do
    if candidate ~= session and candidate.active and candidate.remoteSpyEnabled then
      candidate.remoteSpyOwned = true
      releaseRemote = false
      break
    end
  end
end
session.remoteSpyOwned = false

if action == "cancel" then
  local discarded = session.size
  local disconnected, disconnectErrors = disconnectSession(session, "cancelled", false)
  state.sessions[sessionId] = nil
  if state.current == sessionId then state.current = nil end
  return {
    ok = true,
    action = action,
    sessionId = sessionId,
    active = false,
    cancelled = true,
    discarded = discarded,
    connectionsDisconnected = disconnected,
    disconnectErrors = disconnectErrors,
    remoteSpyEnabled = session.remoteSpyEnabled,
    remoteSpyOwned = releaseRemote,
    expiredSessions = expiredSessions,
  }
end

push({ kind = "session_stopped", reason = "stop" })
local events, cursor, hasMore, eligible = snapshot(0, session.maxEvents)
local disconnected, disconnectErrors = disconnectSession(session, "stopped", false)
state.sessions[sessionId] = nil
if state.current == sessionId then state.current = nil end
return {
  ok = true,
  action = "stop",
  sessionId = sessionId,
  active = false,
  stopped = true,
  startedAt = session.startedAt,
  elapsedSeconds = clock() - session.startedAt,
  events = events,
  cursor = cursor,
  eligible = eligible,
  retained = session.size,
  dropped = session.dropped,
  timelineTruncated = session.dropped > 0 or hasMore,
  maxEvents = session.maxEvents,
  connectionsDisconnected = disconnected,
  disconnectErrors = disconnectErrors,
  remoteSpyEnabled = session.remoteSpyEnabled,
  remoteSpyOwned = releaseRemote,
  expiredSessions = expiredSessions,
  stats = session.stats,
}
`;
}

export default defineTool({
  name: "teach-mode",
  title: "Record a user demonstration and draft a reusable playbook",
  description:
    "Event-driven demonstration recorder with start, poll, stop, and cancel actions. It uses bounded client-side " +
    "ring buffers and temporary Roblox signal connections to observe keyboard, mouse, touch, throttled movement, " +
    "GuiButton activation, meaningful GUI appearance/disappearance, ProximityPrompt triggers, character respawns, " +
    "and Tool equip/backpack transitions. Optional remote capture is started and read through trace-remote-traffic " +
    "via the normal nested-tool invoker when that tool and executor capabilities are available. stop disconnects " +
    "every owned listener, returns the retained chronological timeline, and builds a conservative review-required " +
    "playbook draft with semantic selectors, path evidence, virtual-input/click-button/fire-proximity-prompt and " +
    "remote candidates, inferred waits/guards, placeholders, uncertainty, and manual-review flags. It does not claim " +
    "perfect intent inference. cancel disconnects and discards. Idle sessions self-expire and a three-session cap " +
    "evicts the oldest recorder to prevent leaked listeners.",
  category: "Instrumentation",
  mutatesState: true,
  ai: {
    phase: "orchestrate",
    prerequisites: [
      "An active Roblox client",
      "The user is ready to demonstrate the workflow after action=start",
    ],
    consumes: [
      "User demonstration events",
      "Optional outgoing remote-spy observations",
      "A teach-mode sessionId for poll/stop/cancel",
    ],
    produces: [
      "Bounded chronological event timeline",
      "Semantic instance selectors and path evidence",
      "Conservative reusable playbook draft with uncertainty and review flags",
    ],
    verifiesWith: [
      "teach-mode action=poll to confirm events are arriving",
      "Manual review of selectors, guards, timing, and server-reaching candidates",
      "Run the reviewed playbook in a disposable/test game state and verify outcomes",
    ],
    alternatives: [
      "observe-world for a point-in-time world snapshot",
      "trace-remote-traffic for remote-only capture",
      "script for a manually authored workflow",
    ],
    requiresCapabilities: [
      "UserInputService and Roblox RBXScriptSignal connections",
      "getgenv for state across calls",
      "Optional hookmetamethod/getnamecallmethod/newcclosure for remote capture",
    ],
    sideEffects: [
      "Temporarily installs bounded signal listeners in the active client",
      "May temporarily install a remote-spy metamethod hook when explicitly requested",
      "Does not execute the generated playbook automatically",
    ],
    failureRecovery: [
      "Call teach-mode action=cancel with the sessionId to disconnect and discard",
      "stop/cancel restores an owned remote-spy hook; a direct restoration is used if nested cleanup fails",
      "Idle sessions disconnect automatically and the oldest session is evicted beyond the three-session cap",
    ],
  },
  input: z.object({
    action: z
      .enum(["start", "poll", "stop", "cancel"])
      .describe(
        "start creates the recorder; poll returns retained events after sinceSeq; stop disconnects and returns the " +
          "timeline plus a conservative playbook draft; cancel disconnects and discards the recording.",
      ),
    sessionId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "Optional stable recording id. start generates one when omitted; later actions default to the newest active session.",
      ),
    maxEvents: z
      .number()
      .int()
      .min(50)
      .max(5000)
      .optional()
      .default(1000)
      .describe("start only: circular timeline capacity; oldest events are overwritten and counted."),
    movementThrottleMs: z
      .number()
      .int()
      .min(25)
      .max(1000)
      .optional()
      .default(100)
      .describe("start only: minimum interval for mouse/touch/gamepad movement observations."),
    expirySeconds: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .optional()
      .default(600)
      .describe("start only: idle time before automatic disconnection and session removal."),
    maxGuiWatch: z
      .number()
      .int()
      .min(25)
      .max(1000)
      .optional()
      .default(350)
      .describe("start only: cap on watched GuiObjects/ScreenGuis to keep listener overhead bounded."),
    sinceSeq: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("poll only: return retained local events whose sequence is greater than this cursor."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .default(250)
      .describe("poll only: maximum local timeline events returned in this page."),
    includeRemoteSpy: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "start only: request outgoing remote capture through trace-remote-traffic. Failure is non-fatal and reported.",
      ),
    remoteLimit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(250)
      .describe("Maximum remote-spy entries merged into poll/stop results."),
    sinceRemoteTime: z
      .number()
      .nonnegative()
      .optional()
      .default(0)
      .describe("poll only: omit remote events at or before this many seconds since recording start."),
    threadContext: z.number().int().optional(),
  }),
  async execute(
    {
      action,
      sessionId,
      maxEvents,
      movementThrottleMs,
      expirySeconds,
      maxGuiWatch,
      sinceSeq,
      limit,
      includeRemoteSpy,
      remoteLimit,
      sinceRemoteTime,
      threadContext,
    },
    ctx,
  ): Promise<ToolResult> {
    if (action === "start") {
      const remote = await startRemoteSpy(includeRemoteSpy, remoteLimit, threadContext, ctx);
      const source = buildStartSource({
        ...(sessionId ? { requestedSessionId: sessionId } : {}),
        maxEvents,
        movementThrottleMs,
        expirySeconds,
        maxGuiWatch,
        remoteSpyEnabled: remote.enabled,
        remoteSpyOwned: remote.owned,
      });
      let data: unknown;
      try {
        data = await ctx.runLuau(source, { threadContext, timeoutMs: 30000 });
      } catch (error) {
        if (remote.owned) await releaseOwnedRemoteSpy(true, threadContext, ctx);
        throw error;
      }
      const record = asRecord(data);
      if (asString(record?.["error"])) {
        const cleanup = await releaseOwnedRemoteSpy(remote.owned, threadContext, ctx);
        return {
          data: { ...record, remoteSpyIntegration: remote, remoteSpyCleanup: cleanup },
          isError: true,
          summary: "Teach-mode did not start; any newly owned remote-spy hook was cleaned up.",
        };
      }
      return {
        data: { ...(record ?? { raw: data }), remoteSpyIntegration: remote },
        summary:
          "Teach-mode is recording. Demonstrate the workflow, poll with the returned sessionId, then stop to generate the review-required playbook draft.",
      };
    }

    const source = buildReadSource({
      action,
      ...(sessionId ? { requestedSessionId: sessionId } : {}),
      sinceSeq,
      limit,
    });
    const raw = await ctx.runLuau(source, {
      threadContext,
      timeoutMs: action === "poll" ? 15000 : 20000,
    });
    const rawRecord = asRecord(raw);
    if (asString(rawRecord?.["error"])) {
      return { data: raw, isError: true, summary: asString(rawRecord?.["error"]) };
    }

    if (action === "cancel") {
      const cleanup = await releaseOwnedRemoteSpy(rawRecord?.["remoteSpyOwned"] === true, threadContext, ctx);
      return {
        data: { ...(rawRecord ?? { raw }), remoteSpyCleanup: cleanup },
        summary: "Teach-mode recording cancelled; retained events were discarded and owned listeners were disconnected.",
      };
    }

    const withRemote = await addRemoteTimeline(raw, remoteLimit, sinceRemoteTime, threadContext, ctx);
    if (action === "poll") {
      return {
        data: withRemote,
        summary:
          "Teach-mode poll returned bounded event evidence. Continue from cursor/sinceRemoteTime or stop when the demonstration is complete.",
      };
    }

    const cleanup = await releaseOwnedRemoteSpy(withRemote["remoteSpyOwned"] === true, threadContext, ctx);
    const playbook = generatePlaybook(withRemote);
    return {
      data: { ...withRemote, playbook, remoteSpyCleanup: cleanup },
      summary:
        "Teach-mode stopped and disconnected its listeners. The returned playbook is a conservative review-required draft, not a claim of perfect intent inference.",
    };
  },
});
