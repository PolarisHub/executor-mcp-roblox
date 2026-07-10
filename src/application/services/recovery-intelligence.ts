import { rankTools } from "./tool-discovery.js";
import type { ToolDescriptor, ToolDirectory } from "../ports/tool-directory.js";

export const RECOVERY_CAUSES = [
  "transport-disconnected",
  "no-client-selection",
  "ambiguous-client-selection",
  "stale-or-missing-instance-path",
  "missing-executor-capability",
  "custom-character-hierarchy",
  "timeout",
  "invalid-schema-or-input",
  "permission-or-mutation-blocked",
  "lua-runtime-error",
  "unsupported-operation",
  "unknown",
] as const;

export type RecoveryCause = (typeof RECOVERY_CAUSES)[number];

export interface FailureClassificationInput {
  readonly toolName: string;
  readonly error?: unknown;
  readonly result?: unknown;
  readonly attemptedInput?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface RecoveryRetryPolicy {
  readonly strategy:
    | "after-recovery"
    | "with-corrected-input"
    | "after-state-check"
    | "manual-review"
    | "do-not-retry";
  readonly maxAttempts: number;
  readonly retrySameInput: boolean;
  readonly conditions: readonly string[];
}

export interface RecoveryFallbackTool {
  readonly name: string;
  readonly title: string;
  readonly score: number;
  readonly reason: string;
  readonly mutatesState: boolean;
  readonly requiresClient: boolean;
  readonly requiresCapabilities: readonly string[];
}

export interface RecoveryEnvelope {
  readonly cause: RecoveryCause;
  readonly message: string;
  readonly evidence: readonly string[];
  readonly confidence: number;
  readonly recoverable: boolean;
  readonly retryPolicy: RecoveryRetryPolicy;
  readonly correctedInput?: unknown;
  readonly fallbackTools: readonly RecoveryFallbackTool[];
  readonly recoveryScript?: string;
  readonly nextActions: readonly string[];
}

interface FailureRule {
  readonly cause: Exclude<RecoveryCause, "unknown">;
  readonly message: string;
  readonly confidence: number;
  readonly recoverable: boolean;
  readonly patterns: readonly RegExp[];
}

const FAILURE_RULES: readonly FailureRule[] = [
  {
    cause: "transport-disconnected",
    message: "The bridge transport closed or the selected client disconnected during the call.",
    confidence: 0.96,
    recoverable: true,
    patterns: [
      /\bclient_disconnected\b/i,
      /transport (?:is )?closed/i,
      /bridge (?:transport )?(?:is )?(?:closed|disconnected|lost)/i,
      /client (?:was )?disconnected/i,
      /websocket.*(?:closed|disconnect)/i,
      /socket hang up|broken pipe|econnreset|econnrefused/i,
    ],
  },
  {
    cause: "ambiguous-client-selection",
    message: "Several Roblox clients match this session and no unique target was selected.",
    confidence: 0.97,
    recoverable: true,
    patterns: [
      /\bambiguous_client\b/i,
      /(?:client|selection).*ambiguous|ambiguous.*(?:client|selection)/i,
      /multiple (?:roblox )?(?:clients|accounts)/i,
      /status=ambiguous/i,
      /select-client.*(?:first|required)/i,
    ],
  },
  {
    cause: "no-client-selection",
    message: "No connected Roblox client is currently selected for this session.",
    confidence: 0.96,
    recoverable: true,
    patterns: [
      /\bno_client_selected\b|\bclient_not_found\b/i,
      /no (?:roblox )?clients? (?:are )?connected/i,
      /no[- ]clients|no active client|client (?:is )?not selected/i,
      /active client.*required|requires? (?:an )?active client/i,
      /pinned client is offline|reason=no-clients/i,
    ],
  },
  {
    cause: "invalid-schema-or-input",
    message: "The attempted arguments do not satisfy the selected tool's input contract.",
    confidence: 0.95,
    recoverable: true,
    patterns: [
      /\bvalidation\b/i,
      /invalid (?:arguments?|input|schema)/i,
      /schema validation|zod/i,
      /unrecognized key|unknown field|missing required (?:field|argument)/i,
      /expected .{1,80}(?:received|got)|required at /i,
    ],
  },
  {
    cause: "permission-or-mutation-blocked",
    message: "The operation was blocked by mutation approval, permission, or read-only policy.",
    confidence: 0.94,
    recoverable: true,
    patterns: [
      /mutation (?:is )?not approved|mutation.*blocked/i,
      /allowmutations|permission denied|write access.*denied/i,
      /\bforbidden\b|\bunauthorized\b|not permitted/i,
      /read[- ]only (?:mode|policy|operation)|requires?.*authorization/i,
    ],
  },
  {
    cause: "custom-character-hierarchy",
    message:
      "The game uses a missing, delayed, or custom character hierarchy instead of the standard Character/Humanoid/HumanoidRootPart layout.",
    confidence: 0.95,
    recoverable: true,
    patterns: [
      /characterrecovery|missing-or-custom/i,
      /custom character/i,
      /standard character (?:hierarchy|path).*(?:missing|incomplete|unavailable)/i,
      /humanoidrootpart.*(?:missing|not found|nil|unavailable)/i,
      /(?:missing|custom).*(?:humanoid|root part)/i,
    ],
  },
  {
    cause: "missing-executor-capability",
    message: "The active executor does not expose a capability required by the attempted tool.",
    confidence: 0.94,
    recoverable: true,
    patterns: [
      /capabilit(?:y|ies).*(?:missing|unavailable|unsupported|required)/i,
      /(?:missing|required) executor (?:capability|function)/i,
      /not available in (?:this|the) executor/i,
      /executor (?:does not|doesn't) support/i,
      /(?:getgc|getgenv|hookfunction|newcclosure|firesignal|fireclickdetector|fireproximityprompt|virtualinputmanager).*(?:unavailable|not available|missing|unsupported)/i,
    ],
  },
  {
    cause: "timeout",
    message: "The operation exceeded its execution or transport deadline.",
    confidence: 0.96,
    recoverable: true,
    patterns: [
      /\bexecution_timeout\b/i,
      /timed out|timeout|deadline exceeded/i,
      /did not (?:answer|respond|complete).*(?:deadline|within)/i,
    ],
  },
  {
    cause: "stale-or-missing-instance-path",
    message:
      "The referenced instance path is missing, stale, renamed, or no longer resolves in the live game.",
    confidence: 0.92,
    recoverable: true,
    patterns: [
      /path segment.{0,120}not found/i,
      /(?:instance|object|target|gui|remote) path.*(?:not found|missing|stale|invalid)/i,
      /(?:could not|unable to|failed to) resolve.*(?:path|instance|target|object)/i,
      /instance.{0,100}not found|target.*no longer exists/i,
      /stale (?:instance|path|reference)/i,
      /attempt to index nil.*(?:workspace|player|character)/i,
    ],
  },
  {
    cause: "unsupported-operation",
    message: "The requested tool or operation is not implemented or supported by this surface.",
    confidence: 0.91,
    recoverable: true,
    patterns: [
      /\btool_not_found\b|no tool named .{1,100} registered|unknown tool/i,
      /unsupported operation|operation.*not supported/i,
      /not implemented|unsupported (?:action|method|type|mode)/i,
      /does not implement/i,
    ],
  },
  {
    cause: "lua-runtime-error",
    message: "Luau execution reached the client but failed while compiling or running the script.",
    confidence: 0.9,
    recoverable: true,
    patterns: [
      /\bexecution_failed\b/i,
      /lua(?:u)? runtime|runtime error|stack traceback/i,
      /attempt to (?:index|call|perform arithmetic|concatenate)/i,
      /syntax error|compile error|loadstring.*failed/i,
    ],
  },
];

const PREFERRED_FALLBACKS: Readonly<Record<RecoveryCause, readonly string[]>> = {
  "transport-disconnected": ["bridge-status", "agent-context", "list-clients"],
  "no-client-selection": ["agent-context", "list-clients", "select-client", "get-active-client"],
  "ambiguous-client-selection": ["list-clients", "select-client", "get-active-client"],
  "stale-or-missing-instance-path": [
    "search-instances",
    "verify-path-exists",
    "get-instance-tree",
    "tool-schema",
  ],
  "missing-executor-capability": ["test-capabilities", "get-executor-info", "tool-plan", "script"],
  "custom-character-hierarchy": [
    "discover-character",
    "search-instances",
    "get-local-player-info",
    "script",
  ],
  timeout: ["bridge-status", "agent-context", "tool-schema", "tool-plan"],
  "invalid-schema-or-input": ["tool-schema", "tool-plan"],
  "permission-or-mutation-blocked": ["tool-schema", "agent-run", "agent-context"],
  "lua-runtime-error": ["tool-schema", "script", "get-console-output", "agent-context"],
  "unsupported-operation": ["tool-plan", "tool-schema", "test-capabilities"],
  unknown: ["agent-context", "tool-schema", "tool-plan", "bridge-status"],
};

const CAUSE_QUERIES: Readonly<Record<RecoveryCause, string>> = {
  "transport-disconnected": "inspect bridge transport connection health and connected clients",
  "no-client-selection": "list select inspect active Roblox client",
  "ambiguous-client-selection": "list and select one active Roblox client",
  "stale-or-missing-instance-path": "search resolve verify live instance path and tree",
  "missing-executor-capability": "test executor capabilities and find supported alternative",
  "custom-character-hierarchy": "discover custom player character humanoid root model",
  timeout: "diagnose timeout bridge state and reduce operation scope",
  "invalid-schema-or-input": "inspect tool schema arguments and plan valid input",
  "permission-or-mutation-blocked": "inspect mutation approval and read-only state",
  "lua-runtime-error": "inspect Luau script runtime error and console output",
  "unsupported-operation": "find a supported alternative tool for the goal",
  unknown: "inspect agent context tool schema and bridge diagnostics",
};

const CUSTOM_CHARACTER_RECOVERY_SCRIPT = `local Players = game:GetService("Players")
local player = Players.LocalPlayer
local standard = player and player.Character
local function pathOf(value)
  local ok, path = pcall(function() return value:GetFullName() end)
  return ok and path or tostring(value)
end
local function inspect(model)
  if not model or not model:IsA("Model") then return nil end
  local humanoid = model:FindFirstChildOfClass("Humanoid")
  local root = model:FindFirstChild("HumanoidRootPart", true)
    or model:FindFirstChild("RootPart", true)
    or model:FindFirstChild("LowerTorso", true)
    or model:FindFirstChild("Torso", true)
    or model.PrimaryPart
  if not humanoid and not root then return nil end
  return {
    model = pathOf(model),
    humanoid = humanoid and pathOf(humanoid) or nil,
    rootPart = root and pathOf(root) or nil,
  }
end
local found = inspect(standard)
if found and found.humanoid and found.rootPart then return found end
local queue, head, scanned = workspace:GetChildren(), 1, 0
while head <= #queue and scanned < 1000 do
  local item = queue[head]
  head += 1
  scanned += 1
  local candidate = inspect(item)
  if candidate and candidate.humanoid and candidate.rootPart then return candidate end
  for _, child in ipairs(item:GetChildren()) do
    if #queue >= 1000 then break end
    queue[#queue + 1] = child
  end
end
return { error = "No standard or custom character candidate found in the bounded scan." }`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 420 ? `${normalized.slice(0, 417)}...` : normalized;
}

function collectSignalValue(
  value: unknown,
  path: string,
  output: string[],
  seen: WeakSet<object>,
  depth: number,
): void {
  if (output.length >= 48 || depth > 5 || value === undefined) return;
  if (value instanceof Error) {
    output.push(`${path}.name=${compact(value.name)}`);
    output.push(`${path}.message=${compact(value.message)}`);
    const coded = value as Error & { readonly code?: unknown; readonly details?: unknown };
    if (coded.code !== undefined)
      collectSignalValue(coded.code, `${path}.code`, output, seen, depth + 1);
    if (coded.details !== undefined) {
      collectSignalValue(coded.details, `${path}.details`, output, seen, depth + 1);
    }
    return;
  }
  if (typeof value === "string") {
    if (value.trim()) output.push(`${path}=${compact(value)}`);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    output.push(`${path}=${String(value)}`);
    return;
  }
  if (value === null) {
    output.push(`${path}=null`);
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.slice(0, 12).forEach((entry, index) => {
      collectSignalValue(entry, `${path}[${index}]`, output, seen, depth + 1);
    });
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort().slice(0, 24)) {
    collectSignalValue(record[key], `${path}.${key}`, output, seen, depth + 1);
  }
}

function collectSignals(input: FailureClassificationInput): readonly string[] {
  const output: string[] = [];
  const seen = new WeakSet<object>();
  collectSignalValue(input.error, "error", output, seen, 0);
  collectSignalValue(input.result, "result", output, seen, 0);
  collectSignalValue(input.context, "context", output, seen, 0);
  return output;
}

function classifySignals(signals: readonly string[]): {
  readonly rule: FailureRule | null;
  readonly evidence: readonly string[];
} {
  for (const rule of FAILURE_RULES) {
    const evidence = signals.filter((line) => rule.patterns.some((pattern) => pattern.test(line)));
    if (evidence.length > 0) return { rule, evidence: evidence.slice(0, 6) };
  }
  return { rule: null, evidence: signals.slice(0, 6) };
}

function toolCatalog(
  directory: ToolDirectory | readonly ToolDescriptor[] | undefined,
): readonly ToolDescriptor[] {
  if (!directory) return [];
  if (Array.isArray(directory)) return directory as readonly ToolDescriptor[];
  return (directory as ToolDirectory).list();
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => stableSerialize(entry, seen)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key], seen)}`,
    )
    .join(",")}}`;
}

function different(left: unknown, right: unknown): boolean {
  return stableSerialize(left) !== stableSerialize(right);
}

function findNamedValues(
  value: unknown,
  names: ReadonlySet<string>,
  output: unknown[],
  depth = 0,
  seen = new WeakSet<object>(),
): void {
  if (depth > 4 || value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 20)) findNamedValues(entry, names, output, depth + 1, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (names.has(key.toLowerCase())) output.push(entry);
    findNamedValues(entry, names, output, depth + 1, seen);
  }
}

function validatedCorrection(
  candidate: unknown,
  attemptedInput: unknown,
  target: ToolDescriptor | undefined,
): unknown {
  if (!target || candidate === undefined || !different(candidate, attemptedInput)) return undefined;
  const parsed = target.input.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function deriveCorrectedInput(
  input: FailureClassificationInput,
  target: ToolDescriptor | undefined,
): unknown {
  if (!target || input.attemptedInput === undefined) return undefined;

  const explicit: unknown[] = [];
  const correctionKeys = new Set(["correctedinput", "resolvedinput"]);
  findNamedValues(input.context, correctionKeys, explicit);
  findNamedValues(input.result, correctionKeys, explicit);
  for (const candidate of explicit) {
    const corrected = validatedCorrection(candidate, input.attemptedInput, target);
    if (corrected !== undefined) return corrected;
  }

  const parsedAttempt = target.input.safeParse(input.attemptedInput);
  if (parsedAttempt.success && different(parsedAttempt.data, input.attemptedInput)) {
    return parsedAttempt.data;
  }

  if (!isRecord(input.attemptedInput)) return undefined;
  const attemptedRecord = input.attemptedInput;
  const pathFields = Object.keys(attemptedRecord).filter(
    (key) =>
      typeof attemptedRecord[key] === "string" &&
      /(?:^|_)(?:path|instancepath|targetpath|guipath|remotepath|characterpath|rootpartpath)$/i.test(
        key,
      ),
  );
  if (pathFields.length !== 1) return undefined;

  const pathField = pathFields[0]!;
  const lowerField = pathField.toLowerCase();
  const replacementKeys = new Set(
    lowerField.includes("root")
      ? ["correctedpath", "resolvedpath", "actualpath", "rootpart"]
      : lowerField.includes("character")
        ? ["correctedpath", "resolvedpath", "actualpath", "character", "model"]
        : ["correctedpath", "resolvedpath", "actualpath"],
  );
  const replacements: unknown[] = [];
  findNamedValues(input.context, replacementKeys, replacements);
  findNamedValues(input.result, replacementKeys, replacements);
  const current = attemptedRecord[pathField];
  const unique = [
    ...new Set(
      replacements.filter(
        (value): value is string => typeof value === "string" && value !== current,
      ),
    ),
  ];
  if (unique.length !== 1) return undefined;
  return validatedCorrection(
    { ...attemptedRecord, [pathField]: unique[0] },
    attemptedRecord,
    target,
  );
}

interface RankedCandidate {
  readonly tool: ToolDescriptor;
  score: number;
  readonly reasons: Set<string>;
}

function rankFallbacks(
  cause: RecoveryCause,
  input: FailureClassificationInput,
  catalog: readonly ToolDescriptor[],
  target: ToolDescriptor | undefined,
  signals: readonly string[],
): readonly RecoveryFallbackTool[] {
  const candidates = new Map<string, RankedCandidate>();
  const signalText = signals.join("\n").toLowerCase();
  const blockedWithoutClient = new Set<RecoveryCause>([
    "transport-disconnected",
    "no-client-selection",
    "ambiguous-client-selection",
  ]);

  const add = (name: string, score: number, reason: string): void => {
    const tool = catalog.find((entry) => entry.name === name);
    if (!tool || tool.name === input.toolName || tool.name === "explain-failure") return;
    if (blockedWithoutClient.has(cause) && tool.requiresClient) return;
    if (cause === "permission-or-mutation-blocked" && tool.mutatesState) return;
    const required = tool.ai?.requiresCapabilities ?? [];
    if (
      cause === "missing-executor-capability" &&
      required.some((capability) => signalText.includes(capability.toLowerCase()))
    ) {
      return;
    }
    const existing = candidates.get(name);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.reasons.add(reason);
    } else {
      candidates.set(name, { tool, score, reasons: new Set([reason]) });
    }
  };

  for (const alternative of target?.ai?.alternatives ?? []) {
    add(alternative, 100, `Declared by ${input.toolName}'s AI contract as an alternative.`);
  }
  for (const guidance of target?.ai?.failureRecovery ?? []) {
    const lowerGuidance = guidance.toLowerCase();
    for (const tool of catalog) {
      if (lowerGuidance.includes(tool.name.toLowerCase())) {
        add(tool.name, 96, `Named by ${input.toolName}'s failureRecovery contract.`);
      }
    }
  }
  PREFERRED_FALLBACKS[cause].forEach((name, index) => {
    add(name, 92 - index * 3, `Preferred recovery tool for ${cause}.`);
  });

  const query = [
    CAUSE_QUERIES[cause],
    target?.title,
    target?.description,
    ...(target?.ai?.failureRecovery ?? []),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
  for (const ranked of rankTools(query, catalog, 30)) {
    const score = Math.min(78, 38 + Math.round(ranked.score / 3));
    add(
      ranked.tool.name,
      score,
      ranked.matchedTerms.length > 0
        ? `Live discovery matched ${ranked.matchedTerms.slice(0, 4).join(", ")}.`
        : ranked.why,
    );
  }

  return [...candidates.values()]
    .map(({ tool, score, reasons }) => ({
      name: tool.name,
      title: tool.title,
      score: Math.max(0, Math.min(100, score + (tool.mutatesState ? 0 : 2))),
      reason: [...reasons].slice(0, 3).join(" "),
      mutatesState: tool.mutatesState,
      requiresClient: tool.requiresClient,
      requiresCapabilities: tool.ai?.requiresCapabilities ?? [],
    }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, 6);
}

function retryPolicy(
  cause: RecoveryCause,
  mutatesState: boolean,
  hasCorrectedInput: boolean,
): RecoveryRetryPolicy {
  if (mutatesState) {
    const correctionSafe = hasCorrectedInput && cause === "invalid-schema-or-input";
    return {
      strategy: correctionSafe ? "with-corrected-input" : "after-state-check",
      maxAttempts: correctionSafe ? 1 : 0,
      retrySameInput: false,
      conditions: [
        "First verify whether the original mutation changed live state.",
        "Never repeat the identical mutation input.",
        ...(correctionSafe
          ? ["A single retry is allowed only with the schema-validated correctedInput."]
          : ["Create a corrected plan or input before any later mutation."]),
      ],
    };
  }

  if (cause === "invalid-schema-or-input") {
    return {
      strategy: hasCorrectedInput ? "with-corrected-input" : "manual-review",
      maxAttempts: hasCorrectedInput ? 1 : 0,
      retrySameInput: false,
      conditions: [
        hasCorrectedInput
          ? "Retry once with the schema-validated correctedInput."
          : "Inspect the live tool schema and construct different valid input first.",
      ],
    };
  }
  if (cause === "unsupported-operation") {
    return {
      strategy: "do-not-retry",
      maxAttempts: 0,
      retrySameInput: false,
      conditions: ["Choose a supported fallback tool or operation."],
    };
  }
  if (cause === "permission-or-mutation-blocked" || cause === "unknown") {
    return {
      strategy: "manual-review",
      maxAttempts: 0,
      retrySameInput: false,
      conditions: ["Resolve authorization or gather stronger evidence before another call."],
    };
  }
  return {
    strategy: hasCorrectedInput ? "with-corrected-input" : "after-recovery",
    maxAttempts: 1,
    retrySameInput:
      !hasCorrectedInput && (cause === "transport-disconnected" || cause === "timeout"),
    conditions: [
      hasCorrectedInput
        ? "Apply the recovery step, then retry once with correctedInput."
        : "Apply the listed recovery step and confirm the prerequisite now holds before retrying once.",
    ],
  };
}

function nextActions(
  cause: RecoveryCause,
  input: FailureClassificationInput,
  target: ToolDescriptor | undefined,
  fallbacks: readonly RecoveryFallbackTool[],
  correctedInput: unknown,
): readonly string[] {
  const available = new Set(fallbacks.map((fallback) => fallback.name));
  const actions: string[] = [];
  const add = (action: string): void => {
    if (!actions.includes(action)) actions.push(action);
  };
  const useIfAvailable = (name: string, action: string): void => {
    if (available.has(name)) add(action);
  };

  if (target?.mutatesState) {
    add(
      `Do not repeat ${input.toolName} with the same input; first verify whether the original call already changed state.`,
    );
  }
  switch (cause) {
    case "transport-disconnected":
      useIfAvailable(
        "bridge-status",
        "Call bridge-status to inspect the current bridge and client state.",
      );
      add("Wait for transport recovery or reconnect the client before any client-bound operation.");
      break;
    case "no-client-selection":
      useIfAvailable("list-clients", "Call list-clients to enumerate connected Roblox clients.");
      useIfAvailable(
        "select-client",
        "Call select-client with one exact connected client or account.",
      );
      break;
    case "ambiguous-client-selection":
      useIfAvailable(
        "list-clients",
        "Call list-clients and compare account, place, and job identity.",
      );
      useIfAvailable(
        "select-client",
        "Call select-client with the intended unique client before continuing.",
      );
      break;
    case "stale-or-missing-instance-path":
      useIfAvailable(
        "search-instances",
        "Call search-instances to resolve the target against the live hierarchy.",
      );
      useIfAvailable("verify-path-exists", "Call verify-path-exists on the newly resolved path.");
      add("Replace the stale reference in attemptedInput before another operation.");
      break;
    case "missing-executor-capability":
      useIfAvailable(
        "test-capabilities",
        "Call test-capabilities and confirm the exact missing executor primitive.",
      );
      add("Choose the highest-ranked fallback that does not require the missing capability.");
      break;
    case "custom-character-hierarchy":
      useIfAvailable(
        "discover-character",
        "Call discover-character and consume its resolved model, Humanoid, and root-part paths.",
      );
      add(
        "Use the bounded recoveryScript only when game-specific discovery needs custom adaptation.",
      );
      break;
    case "timeout":
      add(
        "Check bridge/client health and reduce the operation's scope before a single later attempt.",
      );
      if (target?.mutatesState)
        add(
          "Verify the intended postcondition because a timed-out mutation may still have completed.",
        );
      break;
    case "invalid-schema-or-input":
      useIfAvailable(
        "tool-schema",
        `Call tool-schema for ${input.toolName} and compare every required field.`,
      );
      add(
        correctedInput === undefined
          ? "Construct new input that passes the live schema before calling the tool again."
          : "Use only the returned schema-validated correctedInput for a later call.",
      );
      break;
    case "permission-or-mutation-blocked":
      add(
        "Obtain explicit mutation authorization and keep the operation blocked until that approval exists.",
      );
      add(
        "Use a read-only observation or dry run to confirm the intended target and effect first.",
      );
      break;
    case "lua-runtime-error":
      add(
        "Inspect the reported Luau error/line and correct the script or resolved values before executing again.",
      );
      useIfAvailable(
        "get-console-output",
        "Call get-console-output when the game log contains the missing runtime detail.",
      );
      break;
    case "unsupported-operation":
      useIfAvailable(
        "tool-plan",
        "Call tool-plan with the original goal to find a supported workflow.",
      );
      useIfAvailable(
        "tool-schema",
        "Inspect the selected fallback's live schema before calling it.",
      );
      break;
    case "unknown":
      useIfAvailable(
        "agent-context",
        "Call agent-context to collect client, capability, and recent failure context.",
      );
      add(
        "Capture the complete error code/message and handled result before choosing another action.",
      );
      break;
  }

  for (const guidance of target?.ai?.failureRecovery ?? []) {
    if (target?.mutatesState && /retry|repeat/i.test(guidance)) continue;
    add(`Tool contract guidance: ${guidance}`);
  }
  const readOnlyFallback = fallbacks.find((fallback) => !fallback.mutatesState);
  if (readOnlyFallback && !actions.some((action) => action.includes(readOnlyFallback.name))) {
    add(
      `Use ${readOnlyFallback.name} as the highest-ranked read-only fallback: ${readOnlyFallback.reason}`,
    );
  }
  return actions;
}

/**
 * Deterministically explain one failed tool call using its evidence plus the
 * live tool registry. This helper performs no I/O and never invokes a fallback.
 */
export function classifyFailure(
  input: FailureClassificationInput,
  directory?: ToolDirectory | readonly ToolDescriptor[],
): RecoveryEnvelope {
  const catalog = toolCatalog(directory);
  const target = catalog.find((tool) => tool.name === input.toolName);
  const signals = collectSignals(input);
  const classified = classifySignals(signals);
  const cause = classified.rule?.cause ?? "unknown";
  const correctedInput = deriveCorrectedInput(input, target);
  const fallbackTools = rankFallbacks(cause, input, catalog, target, signals);
  const mutation = target?.mutatesState === true;
  const confidence = classified.rule
    ? Math.min(
        1,
        classified.rule.confidence + Math.min(0.03, (classified.evidence.length - 1) * 0.01),
      )
    : 0.2;
  const recoverable = classified.rule?.recoverable ?? false;
  const evidence =
    classified.evidence.length > 0
      ? classified.evidence
      : ["No error, handled result, or contextual failure evidence was supplied."];

  return {
    cause,
    message:
      classified.rule?.message ??
      "The supplied evidence does not match a known deterministic failure signature.",
    evidence,
    confidence,
    recoverable,
    retryPolicy: retryPolicy(cause, mutation, correctedInput !== undefined),
    ...(correctedInput !== undefined ? { correctedInput } : {}),
    fallbackTools,
    ...(cause === "custom-character-hierarchy"
      ? { recoveryScript: CUSTOM_CHARACTER_RECOVERY_SCRIPT }
      : {}),
    nextActions: nextActions(cause, input, target, fallbackTools, correctedInput),
  };
}
