import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/application/tool/define-tool.js";
import { ToolRegistry } from "../../src/application/tool/registry.js";
import { ScriptBridge } from "../../src/application/services/script-bridge.js";
import { SessionManager } from "../../src/application/services/session-manager.js";
import { ToolInvoker } from "../../src/application/services/tool-invoker.js";
import type { ToolInvokerDeps } from "../../src/application/services/tool-invoker.js";
import type { AppConfig } from "../../src/application/ports/config.js";
import type { ActivityRecord } from "../../src/application/ports/activity-log.js";
import type {
  EvalRequest,
  ExecutionGateway,
} from "../../src/application/ports/execution-gateway.js";
import {
  ExecutionFailedError,
  ToolNotFoundError,
  ValidationError,
} from "../../src/domain/errors/errors.js";
import type { ClientId } from "../../src/domain/shared/ids.js";
import { SessionId, UserId } from "../../src/domain/shared/ids.js";
import {
  InMemoryClientDirectory,
  InMemorySessionStore,
  fakeClock,
  makeClient,
  noopMetrics,
  silentLogger,
} from "../helpers/fakes.js";

const SID = SessionId("session-1");
const LABEL = "Test Session";

function testConfig(): AppConfig {
  return {
    server: { host: "127.0.0.1", port: 0 },
    session: { id: SID, label: LABEL },
    logging: { level: "info", pretty: false },
    execution: { defaultTimeoutMs: 5000, defaultThreadContext: 8, scriptDirs: [] },
    semantic: { embeddingsUrl: null, embeddingsModel: "test" },
    bridge: { heartbeatIntervalMs: 15000, authToken: null },
    dashboard: { enabled: false },
  };
}

/** A gateway that records its calls and returns a canned value (or throws). */
function recordingGateway(
  impl?: (clientId: ClientId, request: EvalRequest) => unknown,
): ExecutionGateway & {
  calls: Array<{ clientId: ClientId; request: EvalRequest; signal?: AbortSignal }>;
} {
  const calls: Array<{ clientId: ClientId; request: EvalRequest; signal?: AbortSignal }> = [];
  return {
    calls,
    async eval(clientId, request, signal) {
      calls.push({ clientId, request, signal });
      return impl ? impl(clientId, request) : "ok";
    },
  };
}

function buildDeps(overrides: Partial<ToolInvokerDeps> = {}): {
  deps: ToolInvokerDeps;
  registry: ToolRegistry;
  gateway: ReturnType<typeof recordingGateway>;
  metrics: ReturnType<typeof noopMetrics>;
} {
  const registry = new ToolRegistry();
  const clients = new InMemoryClientDirectory([
    makeClient({ userId: UserId(1), username: "solo" }),
  ]);
  const sessions = new SessionManager(new InMemorySessionStore(), clients);
  const gateway = recordingGateway();
  const metrics = noopMetrics();
  const deps: ToolInvokerDeps = {
    registry,
    sessions,
    gateway,
    clients,
    logger: silentLogger(),
    metrics,
    clock: fakeClock(),
    config: testConfig(),
    host: {
      shell: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
      fs: {
        readText: async () => "",
        list: async () => [],
        exists: async () => false,
        allowedRoots: [],
      },
    },
    semantic: {
      search: async () => [],
      stats: () => ({ indexed: false, documentCount: 0, model: null, dimensions: null }),
      clear: () => undefined,
    },
    activity: {
      record: () => undefined,
      recent: () => [],
      summary: () => ({ total: 0, errors: 0 }),
      perToolStats: () => [],
    },
    scriptBridge: new ScriptBridge(),
    playbooks: {
      save: async (s) => ({ ...s, createdAt: 0, updatedAt: 0 }),
      get: async () => null,
      list: async () => [],
      delete: async () => false,
    },
    sessionLogger: {
      append: () => undefined,
      list: async () => [],
      read: async () => [],
    },
    ...overrides,
  };
  return { deps, registry, gateway, metrics };
}

const echoTool = defineTool({
  name: "echo",
  description: "Echoes its input back.",
  category: "Diagnostics",
  input: z.object({ text: z.string() }),
  requiresClient: false,
  async execute({ text }) {
    return { data: { text } };
  },
});

describe("ToolInvoker", () => {
  it("throws ToolNotFoundError for an unknown tool name", async () => {
    const { deps } = buildDeps();
    const invoker = new ToolInvoker(deps);

    await expect(
      invoker.invoke({ toolName: "nope", input: {}, sessionId: SID, sessionLabel: LABEL }),
    ).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it("throws ValidationError on input that fails the zod schema", async () => {
    const { deps, registry } = buildDeps();
    registry.register(echoTool);
    const invoker = new ToolInvoker(deps);

    try {
      await invoker.invoke({
        toolName: "echo",
        input: { text: 123 },
        sessionId: SID,
        sessionLabel: LABEL,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("VALIDATION");
      const issues = (err as ValidationError).details?.["issues"] as Array<{
        path: string;
        message: string;
      }>;
      expect(issues[0]?.path).toBe("text");
    }
  });

  it("runs a requiresClient:false tool with no client resolved", async () => {
    // No clients connected at all — a client-free tool must still run.
    const emptyClients = new InMemoryClientDirectory([]);
    const { deps, registry } = buildDeps({
      clients: emptyClients,
      sessions: new SessionManager(new InMemorySessionStore(), emptyClients),
    });
    registry.register(echoTool);
    const invoker = new ToolInvoker(deps);

    const result = await invoker.invoke({
      toolName: "echo",
      input: { text: "hi" },
      sessionId: SID,
      sessionLabel: LABEL,
    });
    expect(result.data).toEqual({ text: "hi" });
  });

  it("wires ctx.runLuau to the gateway with config defaults for a client-bound tool", async () => {
    const { deps, registry, gateway } = buildDeps();
    const tool = defineTool({
      name: "run",
      description: "Runs Luau via the context.",
      category: "Execution",
      input: z.object({ src: z.string() }),
      async execute({ src }, ctx) {
        const value = await ctx.runLuau(src);
        return { data: { value, client: ctx.client?.id } };
      },
    });
    registry.register(tool);
    const invoker = new ToolInvoker(deps);

    const result = await invoker.invoke({
      toolName: "run",
      input: { src: "return 1" },
      sessionId: SID,
      sessionLabel: LABEL,
    });

    expect(result.data).toEqual({ value: "ok", client: deps.clients.list()[0]?.id });
    expect(gateway.calls).toHaveLength(1);
    const call = gateway.calls[0]!;
    expect(call.clientId).toBe(deps.clients.list()[0]?.id);
    expect(call.request).toEqual({
      source: "return 1",
      threadContext: 8, // from config.execution.defaultThreadContext
      timeoutMs: 5000, // from config.execution.defaultTimeoutMs
      schedulerKey: "session-1",
    });
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("lets a tool override threadContext and timeoutMs via LuauOptions", async () => {
    const { deps, registry, gateway } = buildDeps();
    const tool = defineTool({
      name: "run-opts",
      description: "Runs Luau with overrides.",
      category: "Execution",
      input: z.object({}),
      async execute(_input, ctx) {
        await ctx.runLuau("return 2", { threadContext: 2, timeoutMs: 100 });
        return { data: {} };
      },
    });
    registry.register(tool);
    const invoker = new ToolInvoker(deps);

    await invoker.invoke({ toolName: "run-opts", input: {}, sessionId: SID, sessionLabel: LABEL });

    expect(gateway.calls[0]?.request).toEqual({
      source: "return 2",
      threadContext: 2,
      timeoutMs: 100,
      schedulerKey: "session-1",
    });
  });

  it("normalizes a thrown error to a DomainError and increments tool.errors", async () => {
    const incremented: Array<{ name: string; tags?: Record<string, string> }> = [];
    const metrics = {
      increment: (name: string, _v?: number, tags?: Record<string, string>) =>
        void incremented.push({ name, tags }),
      observe: () => {},
      gauge: () => {},
    };
    const { deps, registry } = buildDeps({ metrics });
    const tool = defineTool({
      name: "boom",
      description: "Throws a domain error.",
      category: "Execution",
      input: z.object({}),
      async execute() {
        throw new ExecutionFailedError("connector blew up");
      },
    });
    registry.register(tool);
    const invoker = new ToolInvoker(deps);

    await expect(
      invoker.invoke({ toolName: "boom", input: {}, sessionId: SID, sessionLabel: LABEL }),
    ).rejects.toBeInstanceOf(ExecutionFailedError);

    const errorMetric = incremented.find((m) => m.name === "tool.errors");
    expect(errorMetric).toBeDefined();
    expect(errorMetric?.tags).toMatchObject({ tool: "boom", code: "EXECUTION_FAILED" });
  });

  it("wraps a non-DomainError throwable as an INTERNAL DomainError", async () => {
    const { deps, registry } = buildDeps();
    const tool = defineTool({
      name: "raw-throw",
      description: "Throws a plain Error.",
      category: "Execution",
      input: z.object({}),
      async execute() {
        throw new Error("plain failure");
      },
    });
    registry.register(tool);
    const invoker = new ToolInvoker(deps);

    try {
      await invoker.invoke({
        toolName: "raw-throw",
        input: {},
        sessionId: SID,
        sessionLabel: LABEL,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("INTERNAL");
      expect((err as Error).message).toBe("plain failure");
    }
  });

  it("records duration via metrics.observe using the injected clock", async () => {
    const observed: Array<{ name: string; value: number; tags?: Record<string, string> }> = [];
    const clock = fakeClock(0);
    const metrics = {
      increment: () => {},
      observe: (name: string, value: number, tags?: Record<string, string>) =>
        void observed.push({ name, value, tags }),
      gauge: () => {},
    };
    const { deps, registry } = buildDeps({ metrics, clock });
    const tool = defineTool({
      name: "tick",
      description: "Advances the clock while running.",
      category: "Execution",
      input: z.object({}),
      requiresClient: false,
      async execute() {
        clock.advance(250);
        return { data: {} };
      },
    });
    registry.register(tool);
    const invoker = new ToolInvoker(deps);

    await invoker.invoke({ toolName: "tick", input: {}, sessionId: SID, sessionLabel: LABEL });

    const duration = observed.find((m) => m.name === "tool.duration_ms");
    expect(duration?.value).toBe(250);
    expect(duration?.tags).toMatchObject({ tool: "tick", outcome: "ok" });
  });

  it("records compact intelligence result evidence for the live dashboard", async () => {
    const records: ActivityRecord[] = [];
    const { deps, registry } = buildDeps({
      activity: {
        record: (record) => void records.push(record),
        recent: () => records,
        summary: () => ({ total: records.length, errors: 0 }),
        perToolStats: () => [],
      },
    });
    registry.register(
      defineTool({
        name: "smart-task",
        description: "Runs an adaptive task.",
        category: "Intelligence",
        input: z.object({}),
        requiresClient: false,
        async execute() {
          return {
            data: {
              status: "completed",
              goal: "open the shop",
              completionConfidence: 0.8,
              timeline: [{ phase: "observe" }, { phase: "verify" }],
            },
            summary: "Shop opening was verified.",
          };
        },
      }),
    );

    await new ToolInvoker(deps).invoke({
      toolName: "smart-task",
      input: {},
      sessionId: SID,
      sessionLabel: LABEL,
    });

    expect(records[0]).toMatchObject({
      outcome: "ok",
      intelligence: {
        phase: "act",
        status: "completed",
        confidence: 0.8,
        target: "open the shop",
        evidenceCount: 2,
        summary: "Shop opening was verified.",
      },
    });
  });

  it("counts handled tool errors as failed activity instead of successful calls", async () => {
    const records: ActivityRecord[] = [];
    const traces: Array<{ error?: { code?: string } }> = [];
    const { deps, registry } = buildDeps({
      activity: {
        record: (record) => void records.push(record),
        recent: () => records,
        summary: () => ({ total: records.length, errors: records.length }),
        perToolStats: () => [],
      },
      sessionLogger: {
        append: (record) => void traces.push(record),
        list: async () => [],
        read: async () => [],
      },
    });
    registry.register(
      defineTool({
        name: "assert-state",
        description: "Returns a handled failure.",
        category: "Intelligence",
        input: z.object({}),
        requiresClient: false,
        async execute() {
          return { data: { status: "failed", error: "unresolved" }, isError: true };
        },
      }),
    );

    const result = await new ToolInvoker(deps).invoke({
      toolName: "assert-state",
      input: {},
      sessionId: SID,
      sessionLabel: LABEL,
    });

    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({
      status: "failed",
      recovery: {
        retryPolicy: { retrySameInput: false },
        fallbackTools: expect.any(Array),
      },
    });
    expect(records[0]).toMatchObject({
      outcome: "error",
      errorCode: "TOOL_ERROR",
      intelligence: { phase: "verify", status: "failed" },
    });
    expect(traces[0]?.error?.code).toBe("TOOL_ERROR");
  });

  it("aborts the context signal once a tool completes", async () => {
    const { deps, registry } = buildDeps();
    let captured: AbortSignal | undefined;
    const tool = defineTool({
      name: "capture-signal",
      description: "Captures the abort signal.",
      category: "Diagnostics",
      input: z.object({}),
      requiresClient: false,
      async execute(_input, ctx) {
        captured = ctx.signal;
        expect(ctx.signal.aborted).toBe(false);
        return { data: {} };
      },
    });
    registry.register(tool);
    const invoker = new ToolInvoker(deps);

    await invoker.invoke({
      toolName: "capture-signal",
      input: {},
      sessionId: SID,
      sessionLabel: LABEL,
    });
    expect(captured?.aborted).toBe(true);
  });

  it("throws AMBIGUOUS_CLIENT before executing a client-bound tool when ambiguous", async () => {
    const a = makeClient({ userId: UserId(1), username: "alice" });
    const b = makeClient({ userId: UserId(2), username: "bob" });
    const clients = new InMemoryClientDirectory([a, b]);
    const { deps, registry } = buildDeps({
      clients,
      sessions: new SessionManager(new InMemorySessionStore(), clients),
    });
    const exec = vi.fn(async () => ({ data: {} }));
    const tool = defineTool({
      name: "needs-client",
      description: "Requires a resolved client.",
      category: "Execution",
      input: z.object({}),
      execute: exec,
    });
    registry.register(tool);
    const invoker = new ToolInvoker(deps);

    await expect(
      invoker.invoke({
        toolName: "needs-client",
        input: {},
        sessionId: SID,
        sessionLabel: LABEL,
      }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_CLIENT" });
    expect(exec).not.toHaveBeenCalled();
  });
});
