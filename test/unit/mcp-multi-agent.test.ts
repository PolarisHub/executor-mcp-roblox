import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AppConfig } from "../../src/application/ports/config.js";
import type { ToolInvoker } from "../../src/application/services/tool-invoker.js";
import { defineTool } from "../../src/application/tool/define-tool.js";
import { ToolRegistry } from "../../src/application/tool/registry.js";
import { SessionId } from "../../src/domain/shared/ids.js";
import { McpAdapter } from "../../src/infrastructure/mcp/mcp-adapter.js";
import { InMemoryActivityLog } from "../../src/infrastructure/observability/in-memory-activity-log.js";
import { silentLogger } from "../helpers/fakes.js";

const config: AppConfig = {
  server: { host: "127.0.0.1", port: 16384 },
  session: { id: SessionId("stdio-owner"), label: "Owner" },
  logging: { level: "error", pretty: false },
  execution: { defaultTimeoutMs: 5000, defaultThreadContext: 8, scriptDirs: [] },
  semantic: { embeddingsUrl: null, embeddingsModel: "test" },
  bridge: { heartbeatIntervalMs: 2000, authToken: null },
  dashboard: { enabled: false },
};

describe("MCP multi-agent session isolation", () => {
  it("binds each built MCP server to its own logical agent session", async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "session-probe",
        title: "Session probe",
        description: "Test tool.",
        category: "Diagnostics",
        requiresClient: false,
        input: z.object({ query: z.string().optional() }),
        async execute() {
          return { data: {} };
        },
      }),
    );
    const invoke = vi.fn(async (request: { sessionId: string }) => ({
      data: { sessionId: request.sessionId },
    }));
    const adapter = new McpAdapter({
      registry,
      invoker: { invoke } as unknown as ToolInvoker,
      config,
      logger: silentLogger(),
      activity: new InMemoryActivityLog(),
    });
    const serverA = adapter.buildServer({ id: SessionId("agent-a"), label: "Agent A" });
    const serverB = adapter.buildServer({ id: SessionId("agent-b"), label: "Agent B" });
    const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
    const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
    const clientA = new Client({ name: "test-a", version: "1" });
    const clientB = new Client({ name: "test-b", version: "1" });

    await Promise.all([
      serverA.connect(serverTransportA),
      serverB.connect(serverTransportB),
      clientA.connect(clientTransportA),
      clientB.connect(clientTransportB),
    ]);
    try {
      const catalog = await clientA.listTools();
      const registered = catalog.tools.find((tool) => tool.name === "session-probe");
      expect(registered?.description).toContain("Signature: { query: string? }");
      expect(registered?.description).toContain("Phase: observe");
      expect(registered?.description).toContain("Safety: read-only");
      expect(registered?.description).toContain("On failure:");
      expect(registered?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(
        (registered?.inputSchema.properties as Record<string, { description?: string }>)["query"]
          ?.description,
      ).toContain("search text");

      const [resultA] = await Promise.all([
        clientA.callTool({ name: "session-probe", arguments: {} }),
        clientB.callTool({ name: "session-probe", arguments: {} }),
      ]);
      const content = resultA.content as Array<{ type: string; text?: string }>;
      expect(content[0]).toMatchObject({
        type: "text",
        text: "Summary: Session probe completed.",
      });
      expect(invoke.mock.calls.map(([request]) => request.sessionId).sort()).toEqual([
        "agent-a",
        "agent-b",
      ]);
    } finally {
      await Promise.all([clientA.close(), clientB.close(), serverA.close(), serverB.close()]);
    }
  });
});
