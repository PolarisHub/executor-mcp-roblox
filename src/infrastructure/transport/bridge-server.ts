import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { RobloxClient } from "../../domain/client/client.js";
import {
  ClientDisconnectedError,
  ClientNotFoundError,
  ExecutionFailedError,
  ExecutionTimeoutError,
  toDomainError,
} from "../../domain/errors/errors.js";
import { PROTOCOL_VERSION } from "../../domain/protocol/messages.js";
import type {
  ClientHandshake,
  ClientMessage,
  ServerMessage,
} from "../../domain/protocol/messages.js";
import { ClientId, RequestId, UserId } from "../../domain/shared/ids.js";
import type { ClientAdmin } from "../../application/ports/client-admin.js";
import type { ClientDirectory } from "../../application/ports/client-directory.js";
import type { Clock } from "../../application/ports/clock.js";
import type { AppConfig } from "../../application/ports/config.js";
import type { EvalRequest, ExecutionGateway } from "../../application/ports/execution-gateway.js";
import type { Logger } from "../../application/ports/logger.js";
import type { Metrics } from "../../application/ports/metrics.js";
import type { OutputKind, OutputLog } from "../../application/ports/output-log.js";
import type { ScriptBridge } from "../../application/services/script-bridge.js";
import { decodeClientMessage, encodeServerMessage } from "./protocol-codec.js";

const OUTPUT_KINDS: ReadonlySet<string> = new Set([
  "print",
  "info",
  "warn",
  "error",
  "system",
]);

function asOutputKind(value: unknown): OutputKind {
  return typeof value === "string" && OUTPUT_KINDS.has(value) ? (value as OutputKind) : "print";
}

/** Normalize a ws frame to UTF-8 text. ws may deliver a Buffer, ArrayBuffer, or Buffer[]. */
function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/** Server identity reported to connectors in the `welcome` frame. */
const SERVER_VERSION = "2.0.0";

/** A pending eval awaiting its matching `result` frame. */
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  /** Server-side deadline guard; cleared on settle. */
  readonly timer: NodeJS.Timeout;
  /** Detaches the abort listener, if any. */
  readonly disposeAbort?: () => void;
  /** monotonic() at send time, for latency observation. */
  readonly startedAt: number;
}

/** One live connector socket and everything we track for it. */
interface Connection {
  readonly id: ClientId;
  readonly socket: WebSocket;
  client: RobloxClient;
  readonly pending: Map<string, PendingRequest>;
  /** Consecutive heartbeats sent with no intervening pong. */
  missedPongs: number;
}

interface BridgeDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly metrics: Metrics;
  /** Optional sink for game output streamed over the `event` channel. */
  readonly output?: OutputLog;
}

/**
 * The bridge transport. Owns the HTTP server (health + extensible routes) and a
 * WebSocket endpoint at `/bridge` where in-game connectors attach. Implements the
 * {@link ExecutionGateway} (run code on a client, await its result) and the
 * {@link ClientDirectory} (the live read model of connected clients) ports.
 *
 * Lifecycle: construct -> optionally `addRoutes(...)` -> `start()` -> ... ->
 * `stop()`. The composition root may also mount more routes on {@link http}
 * before `start()`.
 */
export class BridgeServer implements ExecutionGateway, ClientDirectory, ClientAdmin {
  readonly http: Hono;

  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly metrics: Metrics;
  private readonly output?: OutputLog;
  private scriptBridge: ScriptBridge | null = null;

  private readonly connections = new Map<ClientId, Connection>();
  private readonly wss: WebSocketServer;
  private httpServer: HttpServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private started = false;

  constructor(deps: BridgeDeps) {
    this.config = deps.config;
    this.logger = deps.logger.child({ component: "bridge" });
    this.clock = deps.clock;
    this.metrics = deps.metrics;
    this.output = deps.output;

    this.http = new Hono();
    this.http.get("/health", (c) => c.json({ status: "ok" }));
    // `/` is left for the composition root to claim (the dashboard, or a fallback).

    // Created in `noServer` mode; we route the HTTP `upgrade` event to it so the
    // same port serves both Hono routes and the `/bridge` WebSocket.
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.wss.on("error", (error) => {
      this.logger.error({ err: toDomainError(error).toJSON() }, "websocket server error");
    });
  }

  /**
   * Let the composition root register additional routes before `start()`.
   * Returns `this.http` so callers can also chain on it directly.
   */
  addRoutes(fn: (app: Hono) => void): Hono {
    fn(this.http);
    return this.http;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const { host, port } = this.config.server;

    await new Promise<void>((resolve, reject) => {
      const server = serve(
        {
          fetch: this.http.fetch,
          hostname: host,
          port,
        },
        () => resolve(),
      ) as HttpServer;

      this.httpServer = server;

      server.on("error", (error) => {
        // Surface bind failures (e.g. EADDRINUSE) to the caller of start().
        reject(toDomainError(error));
      });

      server.on("upgrade", (request, socket, head) => {
        const { url } = request;
        if (!url) {
          socket.destroy();
          return;
        }
        const pathname = new URL(url, `http://${request.headers.host ?? "localhost"}`).pathname;
        if (pathname !== "/bridge") {
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit("connection", ws, request);
        });
      });
    });

    this.startHeartbeat();
    this.logger.info({ host, port }, "bridge listening");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }

    // Tear down every connection: reject in-flight work and close the socket.
    for (const connection of [...this.connections.values()]) {
      this.dropConnection(connection, "server is shutting down");
    }

    await new Promise<void>((resolve) => this.wss.close(() => resolve()));

    const server = this.httpServer;
    this.httpServer = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(toDomainError(error)) : resolve()));
      });
    }

    this.logger.info("bridge stopped");
  }

  // ── ClientDirectory ──────────────────────────────────────────────────────────

  list(): readonly RobloxClient[] {
    return [...this.connections.values()].map((c) => c.client);
  }

  get(clientId: ClientId): RobloxClient | undefined {
    return this.connections.get(clientId)?.client;
  }

  /** Wire the bridge's RPC routing after construction (breaks the dep cycle). */
  attachScripting(scriptBridge: ScriptBridge): void {
    if (this.scriptBridge && this.scriptBridge !== scriptBridge) {
      this.logger.warn("attachScripting called twice; replacing previous script bridge");
    }
    this.scriptBridge = scriptBridge;
  }

  // ── ClientAdmin ──────────────────────────────────────────────────────────────

  disconnect(clientId: ClientId, reason = "disconnected from dashboard"): boolean {
    const connection = this.connections.get(clientId);
    if (!connection) return false;
    this.dropConnection(connection, reason);
    return true;
  }

  // ── ExecutionGateway ─────────────────────────────────────────────────────────

  eval(clientId: ClientId, request: EvalRequest, signal?: AbortSignal): Promise<unknown> {
    const connection = this.connections.get(clientId);
    if (!connection) {
      return Promise.reject(
        new ClientNotFoundError(`Client "${clientId}" is not connected.`, { clientId }),
      );
    }

    if (signal?.aborted) {
      return Promise.reject(this.abortError(signal));
    }

    const requestId = RequestId(randomUUID());
    const timeoutMs = request.timeoutMs ?? this.config.execution.defaultTimeoutMs;
    const threadContext = request.threadContext ?? this.config.execution.defaultThreadContext;

    return new Promise<unknown>((resolve, reject) => {
      const settle = (fn: () => void): void => {
        const pending = connection.pending.get(requestId);
        if (!pending) return; // already settled by another path
        connection.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.disposeAbort?.();
        this.metrics.observe("bridge.eval_ms", this.clock.monotonic() - pending.startedAt);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new ExecutionTimeoutError(`Client did not respond within ${timeoutMs}ms.`, {
              clientId,
              requestId,
              timeoutMs,
            }),
          ),
        );
      }, timeoutMs);
      // Don't let a pending deadline keep the event loop alive on shutdown.
      timer.unref?.();

      let disposeAbort: (() => void) | undefined;
      if (signal) {
        const onAbort = (): void => settle(() => reject(this.abortError(signal)));
        signal.addEventListener("abort", onAbort, { once: true });
        disposeAbort = () => signal.removeEventListener("abort", onAbort);
      }

      connection.pending.set(requestId, {
        resolve,
        reject,
        timer,
        disposeAbort,
        startedAt: this.clock.monotonic(),
      });

      try {
        this.send(connection, {
          type: "op",
          id: requestId,
          op: {
            kind: "eval",
            source: request.source,
            threadContext,
            timeoutMs,
            ...(request.env ? { env: request.env } : {}),
            ...(request.scriptToken ? { scriptToken: request.scriptToken } : {}),
          },
        });
      } catch (error) {
        settle(() => reject(toDomainError(error)));
      }
    });
  }

  // ── connection handling ──────────────────────────────────────────────────────

  private onConnection(socket: WebSocket): void {
    // A socket is anonymous until it sends a valid `hello`. Until then it has no
    // ClientId and is not part of the directory; a bad/absent handshake is dropped.
    let registered: Connection | null = null;
    // Give the handshake a generous window independent of the (possibly fast)
    // heartbeat, so a brief network hiccup on connect doesn't drop a real connector.
    const handshakeTimeoutMs = Math.max(this.config.bridge.heartbeatIntervalMs, 10000);
    const handshakeDeadline = setTimeout(() => {
      if (!registered) {
        this.logger.warn("connector failed to handshake in time; closing");
        socket.close();
      }
    }, handshakeTimeoutMs);
    handshakeDeadline.unref?.();

    socket.on("message", (data) => {
      let message;
      try {
        message = decodeClientMessage(rawDataToString(data));
      } catch (error) {
        this.logger.warn(
          { err: toDomainError(error).toJSON() },
          "dropping malformed bridge message",
        );
        return;
      }

      if (registered) {
        this.handleMessage(registered, message);
        return;
      }

      if (message.type !== "hello") {
        this.logger.warn({ type: message.type }, "expected hello before any other message");
        return;
      }

      clearTimeout(handshakeDeadline);
      registered = this.registerConnection(socket, message.protocolVersion, message.client);
    });

    socket.on("close", () => {
      clearTimeout(handshakeDeadline);
      if (registered) this.dropConnection(registered, "socket closed");
    });

    socket.on("error", (error) => {
      this.logger.warn(
        { err: toDomainError(error).toJSON(), clientId: registered?.id },
        "socket error",
      );
    });
  }

  private registerConnection(
    socket: WebSocket,
    protocolVersion: number,
    handshake: ClientHandshake,
  ): Connection {
    if (protocolVersion !== PROTOCOL_VERSION) {
      this.logger.warn(
        { received: protocolVersion, expected: PROTOCOL_VERSION },
        "connector protocol version mismatch",
      );
    }

    const id = ClientId(randomUUID());
    const client: RobloxClient = {
      id,
      userId: handshake.userId === null ? null : UserId(handshake.userId),
      username: handshake.username,
      displayName: handshake.displayName,
      placeId: handshake.placeId,
      jobId: handshake.jobId,
      executor: handshake.executor,
      capabilities: handshake.capabilities,
      connectedAt: this.clock.now(),
    };

    const connection: Connection = {
      id,
      socket,
      client,
      pending: new Map(),
      missedPongs: 0,
    };
    this.connections.set(id, connection);

    this.metrics.increment("bridge.clients.connected");
    this.metrics.gauge("bridge.clients", this.connections.size);
    this.logger.info(
      { clientId: id, username: client.username, executor: client.executor },
      "connector registered",
    );

    try {
      this.send(connection, {
        type: "welcome",
        serverVersion: SERVER_VERSION,
        heartbeatIntervalMs: this.config.bridge.heartbeatIntervalMs,
      });
    } catch (error) {
      this.logger.error(
        { err: toDomainError(error).toJSON(), clientId: id },
        "failed to send welcome",
      );
    }

    return connection;
  }

  private handleMessage(connection: Connection, message: ClientMessage): void {
    switch (message.type) {
      case "result": {
        const pending = connection.pending.get(message.id);
        if (!pending) {
          // Late/duplicate result (already timed out or aborted). Ignore.
          this.logger.debug(
            { clientId: connection.id, requestId: message.id },
            "result for unknown/settled request",
          );
          return;
        }
        connection.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.disposeAbort?.();
        this.metrics.observe("bridge.eval_ms", this.clock.monotonic() - pending.startedAt);

        const { result } = message;
        if (result.ok) {
          pending.resolve(result.value);
        } else if (result.kind === "timeout") {
          pending.reject(
            new ExecutionTimeoutError(result.error, {
              clientId: connection.id,
              requestId: message.id,
            }),
          );
        } else {
          pending.reject(
            new ExecutionFailedError(result.error, {
              clientId: connection.id,
              requestId: message.id,
            }),
          );
        }
        return;
      }
      case "pong": {
        connection.missedPongs = 0;
        return;
      }
      case "event": {
        if (message.channel === "output") {
          this.recordOutput(connection, message.data);
        } else {
          this.logger.debug(
            { clientId: connection.id, channel: message.channel },
            "connector event",
          );
        }
        return;
      }
      case "hello": {
        // A second hello on an already-registered socket is unexpected; ignore it
        // rather than re-keying a live connection.
        this.logger.warn({ clientId: connection.id }, "duplicate hello ignored");
        return;
      }
      case "rpc-call": {
        void this.handleRpcCall(connection, message);
        return;
      }
      default: {
        const exhaustive: never = message;
        void exhaustive;
        return;
      }
    }
  }

  /**
   * In-game `mcp.<tool>(args)` calls arrive as `rpc-call` frames over this same
   * socket. Route them through the {@link ScriptBridge} (token-gated) and reply
   * with `rpc-result`. Errors are reported back, not thrown, so a flaky tool
   * never breaks the connection.
   */
  private async handleRpcCall(
    connection: Connection,
    msg: { id: string; token: string; tool: string; args: unknown },
  ): Promise<void> {
    const bridge = this.scriptBridge;
    if (!bridge) {
      this.sendRpcResult(connection, msg.id, {
        ok: false,
        error: "scripting bridge not attached",
      });
      return;
    }
    const result = await bridge.run(msg.token, msg.tool, msg.args);
    this.sendRpcResult(connection, msg.id, result);
  }

  private sendRpcResult(
    connection: Connection,
    id: string,
    result:
      | { ok: true; data: unknown }
      | { ok: false; error: string; code?: string },
  ): void {
    try {
      this.send(connection, { type: "rpc-result", id, result });
    } catch (error) {
      this.logger.warn(
        { err: toDomainError(error).toJSON(), clientId: connection.id, rpcId: id },
        "failed to send rpc-result",
      );
    }
  }

  /** Record a batch of game-output lines streamed on the `output` event channel. */
  private recordOutput(connection: Connection, data: unknown): void {
    const sink = this.output;
    if (!sink || typeof data !== "object" || data === null) return;
    const entries = (data as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return;
    const now = this.clock.now();
    for (const raw of entries) {
      if (typeof raw !== "object" || raw === null) continue;
      const e = raw as { kind?: unknown; message?: unknown; at?: unknown };
      const message = typeof e.message === "string" ? e.message : "";
      sink.record({
        clientId: connection.id,
        clientName: connection.client.username,
        kind: asOutputKind(e.kind),
        message,
        at: typeof e.at === "number" && e.at > 0 ? e.at : now,
      });
    }
  }

  /**
   * Remove a connection from the directory, reject every in-flight request with
   * {@link ClientDisconnectedError}, and close the socket. Idempotent.
   */
  private dropConnection(connection: Connection, reason: string): void {
    if (!this.connections.has(connection.id)) {
      // Already dropped; still ensure pending are cleared for safety.
      this.rejectAllPending(connection, reason);
      return;
    }
    this.connections.delete(connection.id);

    this.rejectAllPending(connection, reason);

    try {
      connection.socket.removeAllListeners();
      connection.socket.close();
    } catch {
      // socket may already be closed; nothing actionable.
    }

    this.metrics.increment("bridge.clients.disconnected");
    this.metrics.gauge("bridge.clients", this.connections.size);
    this.logger.info({ clientId: connection.id, reason }, "connector disconnected");
  }

  private rejectAllPending(connection: Connection, reason: string): void {
    for (const [requestId, pending] of connection.pending) {
      connection.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.disposeAbort?.();
      this.metrics.observe("bridge.eval_ms", this.clock.monotonic() - pending.startedAt);
      pending.reject(
        new ClientDisconnectedError(`Client disconnected: ${reason}.`, {
          clientId: connection.id,
          requestId,
        }),
      );
    }
  }

  // ── heartbeat ────────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    const interval = this.config.bridge.heartbeatIntervalMs;
    this.heartbeat = setInterval(() => {
      for (const connection of [...this.connections.values()]) {
        if (connection.missedPongs >= 2) {
          this.dropConnection(connection, "missed two heartbeats");
          continue;
        }
        connection.missedPongs += 1;
        try {
          this.send(connection, { type: "ping", id: randomUUID() });
        } catch (error) {
          this.logger.warn(
            { err: toDomainError(error).toJSON(), clientId: connection.id },
            "heartbeat send failed",
          );
          this.dropConnection(connection, "heartbeat send failed");
        }
      }
    }, interval);
    this.heartbeat.unref?.();
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private send(connection: Connection, message: ServerMessage): void {
    connection.socket.send(encodeServerMessage(message));
  }

  private abortError(signal: AbortSignal): Error {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) {
      return new ExecutionTimeoutError("Eval aborted by caller.", undefined, { cause: reason });
    }
    return new ExecutionTimeoutError("Eval aborted by caller.");
  }
}
