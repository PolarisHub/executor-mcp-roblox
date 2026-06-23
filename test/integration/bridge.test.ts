import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BridgeServer } from "../../src/infrastructure/transport/bridge-server.js";
import { ClientNotFoundError } from "../../src/domain/errors/errors.js";
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

  async function startServer(opts: { authToken?: string | null } = {}): Promise<{ bridge: BridgeServer; port: number }> {
    const config = bridgeConfig();
    if (opts.authToken !== undefined) {
      Object.assign(config, { bridge: { ...config.bridge, authToken: opts.authToken } });
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
});
