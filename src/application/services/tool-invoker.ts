import {
  InternalError,
  ToolNotFoundError,
  ValidationError,
  toDomainError,
} from "../../domain/errors/errors.js";
import type { RobloxClient } from "../../domain/client/client.js";
import type { ClientId, SessionId } from "../../domain/shared/ids.js";
import type {
  ActivityLog,
  IntelligenceActivity,
  IntelligencePhase,
} from "../ports/activity-log.js";
import type { AppConfig } from "../ports/config.js";
import type { Clock } from "../ports/clock.js";
import type { ClientDirectory } from "../ports/client-directory.js";
import type { ExecutionGateway } from "../ports/execution-gateway.js";
import type { EvalPriority } from "../ports/execution-gateway.js";
import type { Logger } from "../ports/logger.js";
import type { Metrics } from "../ports/metrics.js";
import type { SavedScriptsStore } from "../ports/saved-scripts.js";
import type { SemanticIndex } from "../ports/semantic-index.js";
import type { SessionLogger } from "../ports/session-logger.js";
import type { ToolDescriptor, ToolDirectory } from "../ports/tool-directory.js";
import type { HostServices, ToolContext, ToolResult } from "../tool/tool.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { ScriptBridge } from "./script-bridge.js";
import type { SessionManager } from "./session-manager.js";
import { classifyFailure } from "./recovery-intelligence.js";
import { buildToolGuidance } from "./tool-definition-quality.js";

export interface ToolInvokerDeps {
  readonly registry: ToolRegistry;
  readonly sessions: SessionManager;
  readonly gateway: ExecutionGateway;
  readonly clients: ClientDirectory;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly clock: Clock;
  readonly config: AppConfig;
  readonly host: HostServices;
  readonly semantic: SemanticIndex;
  readonly activity: ActivityLog;
  readonly scriptBridge: ScriptBridge;
  readonly playbooks: SavedScriptsStore;
  readonly sessionLogger: SessionLogger;
}

export interface InvocationRequest {
  readonly toolName: string;
  readonly input: unknown;
  readonly sessionId: SessionId;
  readonly sessionLabel: string;
  /** Internal lane used by tools invoked from a parent in-game script. */
  readonly priority?: EvalPriority;
}

const INTELLIGENCE_PHASES: Readonly<Record<string, IntelligencePhase>> = {
  "observe-world": "observe",
  "resolve-entity": "resolve",
  "smart-task": "act",
  "assert-state": "verify",
  "explain-failure": "recover",
  "state-transaction": "rollback",
  "teach-mode": "teach",
  "world-delta": "watch",
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compactString(value: unknown, max = 180): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function finiteUnit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

function countEvidence(data: Record<string, unknown>): number | undefined {
  for (const key of ["evidence", "timeline", "assertions", "results", "events"]) {
    const value = data[key];
    if (Array.isArray(value)) return value.length;
  }
  const aggregate = objectValue(data["aggregate"]);
  return typeof aggregate?.["total"] === "number" ? aggregate["total"] : undefined;
}

function intelligenceDigest(
  toolName: string,
  dataValue: unknown,
  summary: string | undefined,
): IntelligenceActivity | undefined {
  const phase = INTELLIGENCE_PHASES[toolName];
  if (!phase) return undefined;
  const data = objectValue(dataValue) ?? {};
  const aggregate = objectValue(data["aggregate"]);
  const entity = objectValue(data["entity"]);
  const status = compactString(data["status"], 64);
  const confidence =
    finiteUnit(data["completionConfidence"]) ??
    finiteUnit(data["confidence"]) ??
    finiteUnit(aggregate?.["confidence"]);
  const target =
    compactString(data["target"]) ??
    compactString(data["path"]) ??
    compactString(entity?.["path"]) ??
    compactString(data["goal"]);
  const evidence = countEvidence(data);
  const compactSummary = compactString(summary);
  return {
    phase,
    ...(status ? { status } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(target ? { target } : {}),
    ...(evidence !== undefined ? { evidenceCount: evidence } : {}),
    ...(compactSummary ? { summary: compactSummary } : {}),
  };
}

function attachFailureRecovery(dataValue: unknown, recovery: unknown): Record<string, unknown> {
  const data = objectValue(dataValue);
  if (data?.["recovery"] !== undefined) return data;
  return data ? { ...data, recovery } : { result: dataValue, recovery };
}

/** Reserved input key: a per-call target that overrides the session's selection. */
const CLIENT_OVERRIDE_KEY = "client";

/** Reserved input key: a per-call agent lane, for isolation + fair scheduling. */
const AGENT_LANE_KEY = "agent";

/**
 * Resolve an optional per-call `agent` label. Several agents that share ONE MCP
 * session pass distinct labels to get their OWN scheduler fairness lane, their OWN
 * per-game persistent VM, and their OWN queue budget — so they never starve or
 * clobber each other. Sanitized to a short, wire-safe token; returns undefined when
 * absent/blank.
 */
function resolveAgentLane(input: unknown): string | undefined {
  const raw = objectValue(input)?.[AGENT_LANE_KEY];
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * A tool call may carry an optional `client` (a connected client's clientId OR
 * username) to target a specific game for THAT call only. It overrides the
 * session's select-client binding WITHOUT mutating it, so several agents that share
 * one MCP session can drive different games at the same time (each call is routed to
 * its own connection, and the bridge runs connections concurrently). Returns the
 * resolved client, or undefined when no override was supplied; throws a clear
 * {@link ValidationError} when the named client is not currently connected.
 */
function resolveClientOverride(
  input: unknown,
  clients: readonly RobloxClient[],
): RobloxClient | undefined {
  const raw = objectValue(input)?.[CLIENT_OVERRIDE_KEY];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ValidationError(
      "`client` must be a non-empty string: a connected client's clientId or username.",
    );
  }
  const needle = raw.trim();
  // Exact clientId wins; otherwise match username case-insensitively, preferring the
  // most-recently-connected window so a reconnect under a new clientId still resolves.
  const byId = clients.find((c) => c.id === needle);
  if (byId) return byId;
  const lower = needle.toLowerCase();
  const byName = clients
    .filter((c) => c.username !== null && c.username.toLowerCase() === lower)
    .sort((a, b) => b.connectedAt - a.connectedAt);
  if (byName[0]) return byName[0];
  throw new ValidationError(
    `No connected client matches \`client\` = "${needle}" (looked up by clientId then username).`,
    { connected: clients.map((c) => ({ clientId: c.id, username: c.username })) },
  );
}

/**
 * Forward the caller's resolved client and/or agent lane onto a nested invocation's
 * input (via the reserved `client`/`agent` keys) so a composite tool keeps every
 * sub-call on the SAME game and in the SAME fairness/VM lane as the parent — even
 * when the parent was targeted with a per-call override. Keys already present in the
 * nested input still win.
 */
function withForwarded(input: unknown, forward: { client?: ClientId; agent?: string }): unknown {
  const inject: Record<string, unknown> = {};
  if (forward.client !== undefined) inject[CLIENT_OVERRIDE_KEY] = forward.client;
  if (forward.agent !== undefined) inject[AGENT_LANE_KEY] = forward.agent;
  if (Object.keys(inject).length === 0) return input;
  if (input === undefined || input === null) return inject;
  if (typeof input !== "object" || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  for (const [k, v] of Object.entries(inject)) {
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

/**
 * The single use-case that runs a tool. It is the only place that knows the full
 * lifecycle of a call — validate, resolve the target client, build the sandboxed
 * context, time it, record metrics, and normalize every failure into a
 * {@link DomainError}. Tools stay tiny because all of this lives here.
 */
export class ToolInvoker {
  private readonly seqBySession = new Map<string, number>();

  constructor(private readonly deps: ToolInvokerDeps) {}

  /** Loopback URL the executor's HTTP client can reach this server at. */
  private scriptBaseUrl(): string {
    const { host, port } = this.deps.config.server;
    const reachable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return `http://${reachable}:${port}`;
  }

  /** Adapter: present the live registry as a read-only ToolDirectory port. */
  private toolDirectory(): ToolDirectory {
    const { registry } = this.deps;
    const toDescriptor = (tool: ReturnType<ToolRegistry["list"]>[number]): ToolDescriptor => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      category: tool.category,
      mutatesState: tool.mutatesState === true,
      requiresClient: tool.requiresClient !== false,
      ai: tool.ai ?? {
        phase: tool.mutatesState ? "act" : "observe",
        prerequisites: tool.requiresClient === false ? [] : ["active-client"],
        consumes: [],
        produces: [],
        verifiesWith: [],
        alternatives: [],
        requiresCapabilities: [],
        sideEffects: tool.mutatesState ? ["writes live game/client state"] : [],
        failureRecovery: [],
      },
      quality: tool.quality,
      input: tool.input,
    });
    return {
      list: () => registry.list().map(toDescriptor),
      find: (name) => {
        const tool = registry.get(name);
        return tool ? toDescriptor(tool) : null;
      },
    };
  }

  async invoke(request: InvocationRequest): Promise<ToolResult> {
    const { registry, sessions, gateway, clients, metrics, clock, config } = this.deps;
    const tool = registry.get(request.toolName);
    if (!tool) throw new ToolNotFoundError(request.toolName);

    const parsed = tool.input.safeParse(request.input);
    if (!parsed.success) {
      const guidance = buildToolGuidance(tool);
      throw new ValidationError(`Invalid arguments for "${tool.name}".`, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        signature: guidance.signature,
        requiredInputs: guidance.requiredInputs,
        fields: guidance.fields.map((field) => ({
          name: field.name,
          type: field.type,
          optional: field.optional,
          description: field.description,
          ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
          constraints: field.constraints,
          example: field.example,
        })),
        exampleInput: guidance.exampleInput,
        example: guidance.example,
        recovery: guidance.recovery.slice(0, 3),
      });
    }

    const requiresClient = tool.requiresClient !== false;
    // A per-call `client` (clientId/username) targets a specific game for this call
    // only, without touching the session's select-client binding — so concurrent
    // agents (even ones sharing an MCP session) never clobber each other's target.
    // Absent an override, fall back to the session's resolved active client.
    const clientOverride = requiresClient
      ? resolveClientOverride(request.input, clients.list())
      : undefined;
    const client = requiresClient
      ? (clientOverride ?? sessions.requireActiveClient(request.sessionId, request.sessionLabel))
      : undefined;

    // Per-agent lane: distinct agents — even ones multiplexed over ONE MCP session —
    // get their own scheduler fairness, their own per-game persistent VM, and their
    // own queue budget when they tag calls with a distinct `agent`. Without a tag the
    // lane is just the session id (today's behaviour).
    const agentLabel = resolveAgentLane(request.input);
    const laneKey = agentLabel ? `${request.sessionId}#${agentLabel}` : request.sessionId;

    const logger = this.deps.logger.child({
      tool: tool.name,
      session: request.sessionId,
      ...(client ? { client: client.id } : {}),
    });

    const controller = new AbortController();
    const context: ToolContext = {
      logger,
      signal: controller.signal,
      client,
      clients,
      session: sessions.createContext(request.sessionId, request.sessionLabel),
      host: this.deps.host,
      semantic: this.deps.semantic,
      playbooks: this.deps.playbooks,
      sessionLogger: this.deps.sessionLogger,
      tools: this.toolDirectory(),
      invokeTool: (name, input) =>
        this.invoke({
          toolName: name,
          input: withForwarded(input, { ...(client ? { client: client.id } : {}), ...(agentLabel ? { agent: agentLabel } : {}) }),
          sessionId: request.sessionId,
          sessionLabel: request.sessionLabel,
          ...(request.priority ? { priority: request.priority } : {}),
        }),
      scripting: {
        baseUrl: this.scriptBaseUrl(),
        mint: (opts) =>
          this.deps.scriptBridge.mint(
            request.sessionId,
            request.sessionLabel,
            opts?.clientId ?? client?.id,
            agentLabel,
            opts?.budget,
          ),
        knownTools: this.deps.registry.list().map((t) => t.name),
      },
      runLuau: (source, options) => {
        if (!client) {
          throw new InternalError(`Tool "${tool.name}" called runLuau without a resolved client.`);
        }
        return gateway.eval(
          client.id,
          {
            source,
            threadContext: options?.threadContext ?? config.execution.defaultThreadContext,
            timeoutMs: options?.timeoutMs ?? config.execution.defaultTimeoutMs,
            ...(options?.env ? { env: options.env } : {}),
            ...(options?.scriptToken ? { scriptToken: options.scriptToken } : {}),
            ...((options?.priority ?? request.priority)
              ? { priority: options?.priority ?? request.priority }
              : {}),
            schedulerKey: laneKey,
            vmScope: laneKey,
          },
          controller.signal,
        );
      },
      runLuauOn: (targetId, source, options) =>
        gateway.eval(
          targetId,
          {
            source,
            threadContext: options?.threadContext ?? config.execution.defaultThreadContext,
            timeoutMs: options?.timeoutMs ?? config.execution.defaultTimeoutMs,
            ...(options?.env ? { env: options.env } : {}),
            ...(options?.scriptToken ? { scriptToken: options.scriptToken } : {}),
            ...((options?.priority ?? request.priority)
              ? { priority: options?.priority ?? request.priority }
              : {}),
            schedulerKey: laneKey,
            vmScope: laneKey,
          },
          controller.signal,
        ),
    };

    const startedAt = clock.monotonic();
    metrics.increment("tool.invocations", 1, { tool: tool.name });
    const recordActivity = (
      outcome: "ok" | "error",
      elapsed: number,
      options?: { errorCode?: string; intelligence?: IntelligenceActivity },
    ): void => {
      this.deps.activity.record({
        toolName: tool.name,
        category: tool.category,
        sessionId: request.sessionId,
        outcome,
        durationMs: Math.round(elapsed),
        at: clock.now(),
        ...(client ? { clientId: client.id, clientName: client.username } : {}),
        ...(options?.errorCode ? { errorCode: options.errorCode } : {}),
        ...(options?.intelligence ? { intelligence: options.intelligence } : {}),
      });
    };
    const nextSeq = (this.seqBySession.get(request.sessionId) ?? 0) + 1;
    this.seqBySession.set(request.sessionId, nextSeq);
    const recordTrace = (
      outcome: "ok" | "error",
      elapsed: number,
      payload: { result?: unknown; error?: { message: string; code?: string } },
    ): void => {
      this.deps.sessionLogger.append(
        {
          seq: nextSeq,
          at: clock.now(),
          tool: tool.name,
          input: parsed.data,
          elapsedMs: Math.round(elapsed),
          sessionId: request.sessionId,
          ...(client ? { clientId: client.id } : {}),
          ...(outcome === "ok" ? { result: payload.result } : { error: payload.error }),
        },
        request.sessionLabel,
      );
    };
    try {
      const executed = await tool.execute(parsed.data, context);
      const result =
        executed.isError && tool.name !== "explain-failure"
          ? {
              ...executed,
              data: attachFailureRecovery(
                executed.data,
                classifyFailure(
                  {
                    toolName: tool.name,
                    error: executed.summary,
                    result: executed.data,
                    attemptedInput: parsed.data,
                  },
                  context.tools,
                ),
              ),
            }
          : executed;
      const elapsed = clock.monotonic() - startedAt;
      const outcome = result.isError ? "error" : "ok";
      const insight = intelligenceDigest(tool.name, result.data, result.summary);
      metrics.observe("tool.duration_ms", elapsed, { tool: tool.name, outcome });
      if (result.isError) {
        metrics.increment("tool.errors", 1, { tool: tool.name, code: "TOOL_ERROR" });
        recordActivity("error", elapsed, { errorCode: "TOOL_ERROR", intelligence: insight });
        const data = objectValue(result.data);
        const message =
          result.summary ?? compactString(data?.["error"]) ?? "Tool returned a handled error.";
        recordTrace("error", elapsed, { error: { message, code: "TOOL_ERROR" } });
        logger.warn({ ms: Math.round(elapsed) }, "tool completed with handled error");
      } else {
        recordActivity("ok", elapsed, { intelligence: insight });
        recordTrace("ok", elapsed, { result: result.data });
        logger.info({ ms: Math.round(elapsed) }, "tool completed");
      }
      return result;
    } catch (thrown) {
      const error = toDomainError(thrown);
      const elapsed = clock.monotonic() - startedAt;
      metrics.observe("tool.duration_ms", elapsed, { tool: tool.name, outcome: "error" });
      metrics.increment("tool.errors", 1, { tool: tool.name, code: error.code });
      recordActivity("error", elapsed, {
        errorCode: error.code,
        intelligence: intelligenceDigest(tool.name, { status: "error" }, error.message),
      });
      recordTrace("error", elapsed, { error: { message: error.message, code: error.code } });
      logger.warn({ ms: Math.round(elapsed), err: error.toJSON() }, "tool failed");
      throw error;
    } finally {
      controller.abort();
    }
  }
}
