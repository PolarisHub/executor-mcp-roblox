import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BridgeServer } from "../../src/infrastructure/transport/bridge-server.js";
import { ClientNotFoundError } from "../../src/domain/errors/errors.js";
import { ScriptBridge } from "../../src/application/services/script-bridge.js";
import type { ToolInvoker } from "../../src/application/services/tool-invoker.js";
import type { AppConfig } from "../../src/application/ports/config.js";
import type {
  ClientHandshake,
  ClientMessage,
  ServerMessage,
} from "../../src/domain/protocol/messages.js";
import { ClientId, SessionId } from "../../src/domain/shared/ids.js";
import { fakeClock, noopMetrics, silentLogger } from "../helpers/fakes.js";

/**
 * Integration coverage for the BridgeServer transport adapter. A real `ws` client
 * plays the role of the in-game connector: it sends `hello`, expects `welcome`,
 * and replies to `op` frames with `result`.
 *
 * The connector attaches at the `/bridge` path. The server assigns its own opaque
 * ClientId on registration (the handshake clientId is not the directory key), so
 * the tests read the assigned id back from `list()` rather than predicting it.
 */

const HOST = "127.0.0.1";
// A high, fixed port keeps the test deterministic without the server exposing its
// bound address. Picked to avoid common dev-server collisions.
const PORT = 47654;

function bridgeConfig(port = PORT): AppConfig {
  return {
    server: { host: HOST, port },
    session: { id: SessionId("test"), label: "Test" },
    logging: { level: "error", pretty: false },
    execution: { defaultTimeoutMs: 2000, defaultThreadContext: 8, scriptDirs: [] },
    semantic: { embeddingsUrl: null, embeddingsModel: "test" },
    // Long heartbeat so the test's own deadlines, not the server's, drive timing.
    bridge: { heartbeatIntervalMs: 60000, authToken: null },
    dashboard: { enabled: false },
  };
}

function helloMessage(overrides: Partial<ClientHandshake> = {}): string {
  const client: ClientHandshake = {
    clientId: "connector-local-id",
    userId: 1001,
    username: "tester",
    displayName: "Tester",
    placeId: 999,
    jobId: "job-1",
    executor: "TestExecutor",
    capabilities: ["getgc"],
    ...overrides,
  };
  const msg: ClientMessage = { type: "hello", protocolVersion: 1, client };
  return JSON.stringify(msg);
}

/** Wait for a specific server message type (ignoring others, e.g. pings). */
function waitForType<T extends ServerMessage["type"]>(
  ws: WebSocket,
  type: T,
  timeoutMs = 1000,
): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`timed out waiting for "${type}"`));
    }, timeoutMs);
    const onMessage = (raw: Buffer | ArrayBuffer | Buffer[]): void => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg as Extract<ServerMessage, { type: T }>);
      }
    };
    ws.on("message", onMessage);
  });
}

function openSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${port}/bridge`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Poll a predicate until true or the deadline elapses. Avoids fixed sleeps. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!predicate()) throw new Error("condition not met within timeout");
}

describe("BridgeServer (integration)", () => {
  let server: BridgeServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    // Gracefully close every client socket and wait for the server to observe the
    // close, so the bridge's connection set is empty before we stop it. Stopping
    // while a socket's underlying TCP connection is still established would block
    // the HTTP server's close() until the OS times the socket out.
    for (const ws of sockets.splice(0)) {
      ws.removeAllListeners("message");
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.once("error", () => resolve());
          try {
            ws.close();
          } catch {
            resolve();
          }
        });
      }
    }
    if (server) {
      const bridge = server;
      await waitFor(() => bridge.list().length === 0).catch(() => undefined);
      await bridge.stop();
      server = undefined;
    }
  });

  async function startServer(
    opts: {
      authToken?: string | null;
      bridge?: Partial<AppConfig["bridge"]>;
    } = {},
  ): Promise<{ bridge: BridgeServer; port: number }> {
    const config = bridgeConfig();
    if (opts.authToken !== undefined || opts.bridge) {
      Object.assign(config, {
        bridge: {
          ...config.bridge,
          ...opts.bridge,
          ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {}),
        },
      });
    }
    const bridge = new BridgeServer({
      config,
      logger: silentLogger(),
      clock: fakeClock(),
      metrics: noopMetrics(),
    });
    await bridge.start();
    server = bridge;
    return { bridge, port: PORT };
  }

  it("registers a client after a hello and replies with welcome", async () => {
    const { bridge, port } = await startServer();
    const ws = await openSocket(port);
    sockets.push(ws);

    ws.send(helloMessage());
    const welcome = await waitForType(ws, "welcome");
    expect(welcome.serverVersion).toBeTypeOf("string");

    await waitFor(() => bridge.list().length === 1);
    const listed = bridge.list()[0];
    expect(listed?.username).toBe("tester");
    expect(listed?.executor).toBe("TestExecutor");
  });

  it("resolves eval with the value the connector returns", async () => {
    const { bridge, port } = await startServer();
    const ws = await openSocket(port);
    sockets.push(ws);

    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);
    const clientId = bridge.list()[0]!.id;

    // The fake connector answers the next op with a result echoing a value.
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.type === "op") {
        // Echo back so we can also assert the op envelope made it across.
        expect(msg.op.kind).toBe("eval");
        expect(msg.op.source).toBe("return 42 * 42");
        const reply: ClientMessage = {
          type: "result",
          id: msg.id,
          result: { ok: true, value: 1764 },
        };
        ws.send(JSON.stringify(reply));
      }
    });

    const value = await bridge.eval(clientId, { source: "return 42 * 42" });
    expect(value).toBe(1764);
  });

  it("rejects eval for a non-existent client with ClientNotFoundError", async () => {
    const { bridge } = await startServer();
    await expect(
      bridge.eval(ClientId("does-not-exist"), { source: "return 1" }),
    ).rejects.toBeInstanceOf(ClientNotFoundError);
  });

  it("rejects in-flight evals when the socket closes", async () => {
    const { bridge, port } = await startServer();
    const ws = await openSocket(port);
    sockets.push(ws);

    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);
    const clientId = bridge.list()[0]!.id;

    // Start an eval but never answer; instead drop the socket once the op arrives.
    const pending = bridge.eval(clientId, { source: "return forever", timeoutMs: 10000 });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.type === "op") ws.terminate();
    });

    await expect(pending).rejects.toMatchObject({ code: "CLIENT_DISCONNECTED" });
    // And the client should be gone from the directory.
    await waitFor(() => bridge.list().length === 0);
  });

  it("does not reap a busy client mid-eval even when it never pongs", async () => {
    // A CPU-bound eval can block the connector's single Luau VM so it cannot answer
    // pings. The bridge must keep such a client (its per-eval deadline is
    // authoritative) rather than dropping it and failing its work with a spurious
    // ClientDisconnectedError.
    const { bridge, port } = await startServer({ bridge: { heartbeatIntervalMs: 30 } });
    const ws = await openSocket(port);
    sockets.push(ws);

    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);
    const clientId = bridge.list()[0]!.id;

    // Never answer the op and never pong: the eval stays in-flight (pending).
    const pending = bridge.eval(clientId, { source: "block", timeoutMs: 3000 });
    pending.catch(() => undefined); // settled on teardown; avoid an unhandled rejection

    // Ten+ heartbeat ticks pass (~300ms at 30ms). Without the busy-gate the client
    // would have been reaped after ~3 ticks for missing pongs.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bridge.list()).toHaveLength(1);
    // Hard-close so the graceful server.close() in teardown doesn't wait on the
    // still-open socket (the in-flight eval rejects; already .catch()'d above).
    ws.terminate();
  });

  it("bounds concurrent evals and drains queued work without flooding the client", async () => {
    const { bridge, port } = await startServer({
      bridge: { maxConcurrentEvals: 2, maxQueuedEvals: 16 },
    });
    const ws = await openSocket(port);
    sockets.push(ws);
    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);
    const clientId = bridge.list()[0]!.id;
    const received: Extract<ServerMessage, { type: "op" }>[] = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "op") received.push(message);
    });

    const runs = Array.from({ length: 6 }, (_, index) =>
      bridge.eval(clientId, { source: `return ${index}`, timeoutMs: 5000 }),
    );
    await waitFor(() => received.length === 2);
    expect(bridge.loadSnapshot()).toMatchObject({ activeEvals: 2, queuedEvals: 4 });

    let replied = 0;
    while (replied < runs.length) {
      await waitFor(() => received.length > replied);
      const op = received[replied]!;
      ws.send(
        JSON.stringify({
          type: "result",
          id: op.id,
          result: { ok: true, value: replied },
        } satisfies ClientMessage),
      );
      replied += 1;
    }
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(bridge.loadSnapshot()).toMatchObject({ activeEvals: 0, queuedEvals: 0 });
  });

  it("sustains a 100-call multi-agent burst while keeping client concurrency bounded", async () => {
    const { bridge, port } = await startServer({
      bridge: { maxConcurrentEvals: 2, maxQueuedEvals: 128 },
    });
    const ws = await openSocket(port);
    sockets.push(ws);
    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);
    const clientId = bridge.list()[0]!.id;
    let inFlight = 0;
    let peakInFlight = 0;
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type !== "op") return;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        ws.send(
          JSON.stringify({
            type: "result",
            id: message.id,
            result: { ok: true, value: message.op.source },
          } satisfies ClientMessage),
        );
      }, 2);
    });

    const runs = Array.from({ length: 100 }, (_, index) =>
      bridge.eval(clientId, { source: `return ${index}`, timeoutMs: 5000 }),
    );
    const values = await Promise.all(runs);

    expect(values).toHaveLength(100);
    expect(peakInFlight).toBeLessThanOrEqual(2);
    expect(bridge.loadSnapshot()).toMatchObject({ activeEvals: 0, queuedEvals: 0 });
  });

  it("round-robins queued agents instead of letting one noisy session monopolize dispatch", async () => {
    const { bridge, port } = await startServer({
      bridge: { maxConcurrentEvals: 2, maxQueuedEvals: 32 },
    });
    const ws = await openSocket(port);
    sockets.push(ws);
    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);
    const clientId = bridge.list()[0]!.id;
    const received: Extract<ServerMessage, { type: "op" }>[] = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "op") received.push(message);
    });

    const runs = [
      ...Array.from({ length: 4 }, (_, index) =>
        bridge.eval(clientId, {
          source: `return 'agent-a-${index}'`,
          schedulerKey: "agent-a",
          timeoutMs: 5000,
        }),
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        bridge.eval(clientId, {
          source: `return 'agent-b-${index}'`,
          schedulerKey: "agent-b",
          timeoutMs: 5000,
        }),
      ),
    ];
    await waitFor(() => received.length === 2);
    expect(received.every((message) => message.op.source.includes("agent-a"))).toBe(true);

    ws.send(
      JSON.stringify({
        type: "result",
        id: received[0]!.id,
        result: { ok: true, value: "done" },
      } satisfies ClientMessage),
    );
    await waitFor(() => received.length === 3);
    expect(received[2]!.op.source).toContain("agent-b");

    const replied = new Set([received[0]!.id]);
    while (replied.size < runs.length) {
      const next = received.find((message) => !replied.has(message.id));
      if (!next) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        continue;
      }
      replied.add(next.id);
      ws.send(
        JSON.stringify({
          type: "result",
          id: next.id,
          result: { ok: true, value: "done" },
        } satisfies ClientMessage),
      );
    }
    await expect(Promise.all(runs)).resolves.toHaveLength(6);
  });

  it("reserves a nested lane so a parent script cannot deadlock on mcp tool work", async () => {
    const { bridge, port } = await startServer({
      bridge: { maxConcurrentEvals: 2, maxQueuedEvals: 16 },
    });
    const ws = await openSocket(port);
    sockets.push(ws);
    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);
    const clientId = bridge.list()[0]!.id;
    const received: Extract<ServerMessage, { type: "op" }>[] = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "op") received.push(message);
    });

    const parent = bridge.eval(clientId, {
      source: "return mcp.getPlayers()",
      scriptToken: "parent-token",
      timeoutMs: 5000,
    });
    const ordinary = bridge.eval(clientId, { source: "return 'ordinary'", timeoutMs: 5000 });
    const nested = bridge.eval(clientId, {
      source: "return 'nested'",
      priority: "nested",
      timeoutMs: 5000,
    });

    await waitFor(() => received.length === 2);
    expect(received.map((message) => message.op.priority)).toEqual(["normal", "nested"]);
    expect(received.some((message) => message.op.source.includes("ordinary"))).toBe(false);

    const nestedOp = received.find((message) => message.op.priority === "nested")!;
    ws.send(
      JSON.stringify({
        type: "result",
        id: nestedOp.id,
        result: { ok: true, value: "nested" },
      } satisfies ClientMessage),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(2);

    const parentOp = received.find((message) => message.op.scriptToken === "parent-token")!;
    ws.send(
      JSON.stringify({
        type: "result",
        id: parentOp.id,
        result: { ok: true, value: "parent" },
      } satisfies ClientMessage),
    );
    await waitFor(() => received.length === 3);
    const ordinaryOp = received[2]!;
    expect(ordinaryOp.op.source).toContain("ordinary");
    ws.send(
      JSON.stringify({
        type: "result",
        id: ordinaryOp.id,
        result: { ok: true, value: "ordinary" },
      } satisfies ClientMessage),
    );

    await expect(Promise.all([parent, ordinary, nested])).resolves.toEqual([
      "parent",
      "ordinary",
      "nested",
    ]);
  });

  it("rejects excess queued work with a retryable overload error", async () => {
    const { bridge, port } = await startServer({
      bridge: { maxConcurrentEvals: 2, maxQueuedEvals: 3 },
    });
    const ws = await openSocket(port);
    sockets.push(ws);
    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);
    const clientId = bridge.list()[0]!.id;
    const held = Array.from({ length: 4 }, (_, index) =>
      bridge.eval(clientId, { source: `return ${index}`, timeoutMs: 10000 }),
    );
    await waitFor(() => bridge.loadSnapshot().activeEvals === 2);

    await expect(
      bridge.eval(clientId, { source: "return 'overflow'", timeoutMs: 10000 }),
    ).rejects.toMatchObject({ code: "BRIDGE_OVERLOADED", retryable: true });
    expect(bridge.loadSnapshot().rejectedEvals).toBe(1);

    ws.terminate();
    await Promise.allSettled(held);
  });

  it("rejects a hello whose token does not match the server's authToken", async () => {
    const { bridge, port } = await startServer({ authToken: "secret-x" });
    const ws = await openSocket(port);
    sockets.push(ws);

    const closed = new Promise<{ code: number }>((resolve) =>
      ws.once("close", (code) => resolve({ code })),
    );
    ws.send(helloMessage({ token: "wrong" }));
    const result = await closed;
    expect(result.code).toBe(1008);
    expect(bridge.list().length).toBe(0);
  });

  it("accepts a hello whose token matches the server's authToken", async () => {
    const { bridge, port } = await startServer({ authToken: "secret-x" });
    const ws = await openSocket(port);
    sockets.push(ws);

    ws.send(helloMessage({ token: "secret-x" }));
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);
  });

  /** Test helper: wire the bridge to a ScriptBridge backed by a fake invoker
   *  that returns a recorded result per tool name. Returns the bridge + the
   *  ScriptBridge so the test can mint tokens. */
  async function startServerWithScripting(tools: Record<string, unknown>): Promise<{
    bridge: BridgeServer;
    port: number;
    scriptBridge: ScriptBridge;
  }> {
    const { bridge, port } = await startServer();
    const scriptBridge = new ScriptBridge();
    scriptBridge.attach({
      invoke: async (req: { toolName: string }) => {
        if (!(req.toolName in tools)) {
          throw new Error(`fake invoker: no tool "${req.toolName}"`);
        }
        return { data: tools[req.toolName] };
      },
    } as unknown as ToolInvoker);
    bridge.attachScripting(scriptBridge);
    return { bridge, port, scriptBridge };
  }

  it("routes a script's rpc-call through ScriptBridge and replies rpc-result", async () => {
    const { bridge, port, scriptBridge } = await startServerWithScripting({
      "get-players": { players: ["alice", "bob"], count: 2 },
    });
    const ws = await openSocket(port);
    sockets.push(ws);
    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);

    const { token, dispose } = scriptBridge.mint(SessionId("s1"), "test");

    // Simulate the connector calling mcp.getPlayers() inside a running script.
    ws.send(
      JSON.stringify({
        type: "rpc-call",
        id: "r1",
        token,
        tool: "get-players",
        args: {},
      } satisfies ClientMessage),
    );
    const result = await waitForType(ws, "rpc-result");
    expect(result.id).toBe("r1");
    expect(result.result.ok).toBe(true);
    if (result.result.ok) {
      expect(result.result.data).toEqual({ players: ["alice", "bob"], count: 2 });
    }
    dispose();
  });

  it("rejects rpc-call with a bad token", async () => {
    const { bridge, port } = await startServerWithScripting({ x: 1 });
    const ws = await openSocket(port);
    sockets.push(ws);
    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    await waitFor(() => bridge.list().length === 1);
    ws.send(
      JSON.stringify({
        type: "rpc-call",
        id: "r2",
        token: "wrong-token",
        tool: "x",
        args: {},
      } satisfies ClientMessage),
    );
    const result = await waitForType(ws, "rpc-result");
    expect(result.result.ok).toBe(false);
  });

  it("routes rpc-batch to one rpc-batch-result preserving key order", async () => {
    const { port, scriptBridge } = await startServerWithScripting({
      "tool-a": { from: "a" },
      "tool-b": { from: "b" },
      "tool-c": { from: "c" },
    });
    const ws = await openSocket(port);
    sockets.push(ws);
    ws.send(helloMessage());
    await waitForType(ws, "welcome");
    const { token, dispose } = scriptBridge.mint(SessionId("s1"), "test");

    ws.send(
      JSON.stringify({
        type: "rpc-batch",
        id: "b1",
        token,
        calls: [
          { key: "p1", tool: "tool-a", args: {} },
          { key: "p2", tool: "tool-b", args: {} },
          { key: "p3", tool: "tool-c", args: {} },
        ],
      } satisfies ClientMessage),
    );
    const batch = await waitForType(ws, "rpc-batch-result");
    expect(batch.id).toBe("b1");
    expect(batch.results.map((r) => r.key)).toEqual(["p1", "p2", "p3"]);
    expect(batch.results.every((r) => r.ok)).toBe(true);
    dispose();
  });

  it("routes pubsub-publish to every subscriber except sender", async () => {
    const { port } = await startServer();
    const publisher = await openSocket(port);
    const sub1 = await openSocket(port);
    const sub2 = await openSocket(port);
    sockets.push(publisher, sub1, sub2);

    publisher.send(helloMessage({ clientId: "pub" }));
    sub1.send(helloMessage({ clientId: "s1" }));
    sub2.send(helloMessage({ clientId: "s2" }));
    await Promise.all([
      waitForType(publisher, "welcome"),
      waitForType(sub1, "welcome"),
      waitForType(sub2, "welcome"),
    ]);

    sub1.send(JSON.stringify({ type: "pubsub-subscribe", channel: "feed" }));
    sub2.send(JSON.stringify({ type: "pubsub-subscribe", channel: "feed" }));
    // tiny gap so the server registers both subs before the publish
    await new Promise((r) => setTimeout(r, 30));

    const recv1 = waitForType(sub1, "pubsub-message");
    const recv2 = waitForType(sub2, "pubsub-message");
    publisher.send(
      JSON.stringify({ type: "pubsub-publish", channel: "feed", payload: { ping: 1 } }),
    );

    const [m1, m2] = await Promise.all([recv1, recv2]);
    expect(m1.frame.channel).toBe("feed");
    expect(m1.frame.payload).toEqual({ ping: 1 });
    expect(m2.frame.payload).toEqual({ ping: 1 });
    // The publisher itself should NOT receive its own message.
    let publisherGotEcho = false;
    publisher.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      if (m.type === "pubsub-message") publisherGotEcho = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(publisherGotEcho).toBe(false);
  });
});
