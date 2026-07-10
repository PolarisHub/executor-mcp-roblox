import { randomUUID } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface Session {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

interface SessionRef {
  current?: Session;
}

export interface McpHttpEndpointDeps {
  readonly createServer: () => McpServer;
}

/**
 * Stateful MCP-over-HTTP endpoint used by the launcher when another stdio
 * server already owns the configured bridge port. Each HTTP client gets its
 * own MCP server/transport session, while all sessions share the same Roblox
 * bridge and tool implementation.
 */
export class McpHttpEndpoint {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: McpHttpEndpointDeps) {}

  async handle(request: Request): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return new Response(JSON.stringify({ error: "Unknown MCP session." }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
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

    const sessionRef: SessionRef = {};
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
    const server = this.deps.createServer();
    sessionRef.current = { server, transport };
    await server.connect(transport);
    return transport.handleRequest(request);
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
}
