import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DomainError, toDomainError } from "../../domain/errors/errors.js";
import type { AppConfig } from "../../application/ports/config.js";
import type { Logger } from "../../application/ports/logger.js";
import type { ToolInvoker } from "../../application/services/tool-invoker.js";
import type { Tool } from "../../application/tool/tool.js";
import type { ToolRegistry } from "../../application/tool/registry.js";
import { formatDomainError } from "./error-mapping.js";

const SERVER_NAME = "executor-mcp-roblox";
const DEFAULT_VERSION = "2.0.0";
const MUTATES_NOTE = " (writes live game state)";

export interface McpAdapterDeps {
  readonly registry: ToolRegistry;
  readonly invoker: ToolInvoker;
  readonly config: AppConfig;
  readonly logger: Logger;
}

/**
 * Exposes the {@link ToolRegistry} over the Model Context Protocol stdio
 * transport. This is the only place that knows about the MCP SDK: it translates
 * each registered {@link Tool} into an SDK tool registration, routes every call
 * through the {@link ToolInvoker}, and maps domain results/errors onto MCP
 * content. Nothing below the interface layer touches the SDK.
 */
export class McpAdapter {
  private server?: McpServer;

  constructor(private readonly deps: McpAdapterDeps) {}

  /** Build the MCP server and register every catalog tool plus `list-tools`. */
  buildServer(): McpServer {
    const { registry, logger } = this.deps;
    const server = new McpServer({ name: SERVER_NAME, version: DEFAULT_VERSION });

    for (const tool of registry.list()) {
      this.registerTool(server, tool);
    }
    this.registerListTools(server);

    logger.info(
      { tools: registry.size, categories: registry.categoryCounts().length },
      "MCP server built",
    );
    this.server = server;
    return server;
  }

  /** Connect the built server over the stdio transport. */
  async connectStdio(): Promise<void> {
    const server = this.server ?? this.buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.deps.logger.info("MCP server connected over stdio");
  }

  private registerTool(server: McpServer, tool: Tool): void {
    const { invoker, config } = this.deps;
    const description = tool.mutatesState ? `${tool.description}${MUTATES_NOTE}` : tool.description;
    const shape = (tool.input as z.ZodObject<z.ZodRawShape>).shape;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description,
        inputSchema: shape,
        annotations: {
          title: tool.title,
          readOnlyHint: !tool.mutatesState,
          destructiveHint: tool.mutatesState === true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await invoker.invoke({
            toolName: tool.name,
            input: args,
            sessionId: config.session.id,
            sessionLabel: config.session.label,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
            isError: result.isError ?? false,
          };
        } catch (thrown) {
          const error = thrown instanceof DomainError ? thrown : toDomainError(thrown);
          return {
            content: [{ type: "text" as const, text: formatDomainError(error) }],
            isError: true,
          };
        }
      },
    );
  }

  /**
   * The built-in discovery tool. It lives here (not in src/tools) because it
   * needs read access to the {@link ToolRegistry}, which tools are deliberately
   * never given. With no args it returns category counts + total; with
   * `{ category }` it lists that category's tools; with `{ search }` it
   * keyword-matches across name/title/description.
   */
  private registerListTools(server: McpServer): void {
    const input = z.object({
      category: z
        .string()
        .describe(
          "Restrict to one category (use the exact name shown in the no-argument overview).",
        )
        .optional(),
      search: z
        .string()
        .describe("Keyword matched across each tool's name, title, and description.")
        .optional(),
    });

    server.registerTool(
      "list-tools",
      {
        title: "Browse/search this server's tools by category",
        description:
          "Discover the right tool without scanning all of them. Call with NO arguments to see every " +
          "category and its count plus the total. Pass { category } to list that category's tools, or " +
          "{ search } to keyword-match across tool names, titles, and descriptions. Reads the server's " +
          "own tool catalog (no game client required).",
        inputSchema: input.shape,
        annotations: { title: "Browse/search this server's tools", readOnlyHint: true },
      },
      async (args: z.infer<typeof input>) => {
        const data = this.runListTools(args.category, args.search);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          isError: false,
        };
      },
    );
  }

  private runListTools(category?: string, search?: string): unknown {
    const { registry } = this.deps;

    if (!category && !search) {
      const counts = registry.categoryCounts();
      return {
        total: registry.size,
        categories: counts,
        hint: "Pass { category } to list a category's tools, or { search } to keyword-match.",
      };
    }

    const term = search?.toLowerCase();
    const matches = registry
      .list()
      .filter((tool) => (category ? tool.category === category : true))
      .filter((tool) =>
        term
          ? tool.name.toLowerCase().includes(term) ||
            tool.title.toLowerCase().includes(term) ||
            tool.description.toLowerCase().includes(term)
          : true,
      )
      .map((tool) => ({ name: tool.name, title: tool.title, category: tool.category }));

    return {
      ...(category ? { category } : {}),
      ...(search ? { search } : {}),
      count: matches.length,
      tools: matches,
    };
  }
}
