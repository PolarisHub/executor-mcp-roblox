import { randomUUID } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionId } from "../../domain/shared/ids.js";
import type { McpSessionIdentity } from "./mcp-adapter.js";

const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

interface Session {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly identity: McpSessionIdentity;
  lastUsedAt: number;
}

interface SessionRef {
  current?: Session;
}

export interface McpHttpEndpointDeps {
  readonly createServer: (identity: McpSessionIdentity) => McpServer;
  readonly sessionLabelPrefix?: string;
  readonly maxSessions?: number;
  readonly idleTtlMs?: number;
}

/**
 * Stateful MCP-over-HTTP endpoint used by the launcher when another stdio
 * server already owns the configured bridge port. Each HTTP client gets its
 * own MCP server/transport session, while all sessions share the same Roblox
 * bridge and tool implementation.
 */
export class McpHttpEndpoint {
  private readonly sessions = new Map<string, Session>();
  private initializing = 0;

  constructor(private readonly deps: McpHttpEndpointDeps) {}

  async handle(request: Request): Promise<Response> {
    await this.sweepIdleSessions();
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return new Response(JSON.stringify({ error: "Unknown MCP session." }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      session.lastUsedAt = Date.now();
      return session.transport.handleRequest(request);
    }

    // Only an initialization POST may create a new stateful session. Let the
    // SDK produce the standards-compliant error for a session-less GET/DELETE.
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "MCP session is required." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    if (this.sessions.size + this.initializing >= this.maxSessions()) {
      return new Response(
        JSON.stringify({
          error: "MCP agent session capacity reached.",
          retryable: true,
          activeSessions: this.sessions.size,
          limit: this.maxSessions(),
        }),
        {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "1" },
        },
      );
    }

    const sessionRef: SessionRef = {};
    const logicalId = SessionId(randomUUID());
    const identity: McpSessionIdentity = {
      id: logicalId,
      label: `${this.deps.sessionLabelPrefix ?? "agent"}-${logicalId.replace(/-/g, "").slice(0, 8)}`,
    };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        if (sessionRef.current) this.sessions.set(id, sessionRef.current);
      },
      onsessionclosed: (id) => {
        const existing = this.sessions.get(id);
        this.sessions.delete(id);
        if (existing) void existing.server.close().catch(() => undefined);
      },
    });
    const server = this.deps.createServer(identity);
    sessionRef.current = { server, transport, identity, lastUsedAt: Date.now() };
    this.initializing += 1;
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      throw error;
    } finally {
      this.initializing = Math.max(0, this.initializing - 1);
    }
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async ({ server, transport }) => {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }),
    );
  }

  private maxSessions(): number {
    return Math.max(1, this.deps.maxSessions ?? DEFAULT_MAX_SESSIONS);
  }

  private idleTtlMs(): number {
    return Math.max(60_000, this.deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
  }

  private async sweepIdleSessions(): Promise<void> {
    const cutoff = Date.now() - this.idleTtlMs();
    const expired: Session[] = [];
    for (const [id, session] of this.sessions) {
      if (session.lastUsedAt >= cutoff) continue;
      this.sessions.delete(id);
      expired.push(session);
    }
    await Promise.all(
      expired.map(async ({ server, transport }) => {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }),
    );
  }
}
