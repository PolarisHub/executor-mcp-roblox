import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DomainError, toDomainError } from "../../domain/errors/errors.js";
import type { ActivityLog } from "../../application/ports/activity-log.js";
import type { AppConfig } from "../../application/ports/config.js";
import type { Logger } from "../../application/ports/logger.js";
import type { ToolInvoker } from "../../application/services/tool-invoker.js";
import type { Tool } from "../../application/tool/tool.js";
import type { ToolRegistry } from "../../application/tool/registry.js";
import { formatDomainError } from "./error-mapping.js";

const SERVER_NAME = "executor-mcp-roblox";
const DEFAULT_VERSION = "2.0.0";
const MUTATES_NOTE = " (writes live game state)";

/**
 * Encode tool data as a stable string for the MCP response. JSON.stringify can
 * throw (circular refs, BigInt) or return literal `undefined` for `undefined`
 * inputs — both of which would corrupt the SDK response. Fall back to a marker
 * string so the AI gets *something* rather than a transport crash.
 */
function safeStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    const encoded = JSON.stringify(value, null, 2);
    // JSON.stringify returns `undefined` for symbols / functions; degrade to a
    // marker rather than handing the SDK something it'll reject as not-a-string.
    return encoded ?? "<unserializable result>";
  } catch (err) {
    return `<unserializable result: ${(err as Error).message}>`;
  }
}

export interface McpAdapterDeps {
  readonly registry: ToolRegistry;
  readonly invoker: ToolInvoker;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly activity: ActivityLog;
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
    const server = new McpServer(
      { name: SERVER_NAME, version: DEFAULT_VERSION },
      { instructions: this.buildInstructions() },
    );

    for (const tool of registry.list()) {
      this.registerTool(server, tool);
    }
    this.registerListTools(server);
    this.registerSuggestTools(server);

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

  /**
   * Server-level guidance returned at initialize. It tells the model the real
   * breadth of the toolset (so it doesn't default to a handful of tools) and
   * points it at `list-tools` for discovery and `script` for orchestration.
   */
  private buildInstructions(): string {
    const { registry } = this.deps;
    const counts = registry.categoryCounts();
    const cats = counts.map((c) => `${c.category} (${c.count})`).join(", ");
    return [
      `This server gives you deep, low-level control of a LIVE Roblox game through an executor: ` +
        `${registry.size} tools across ${counts.length} categories — ${cats}.`,
      `*** READ THIS FIRST — THE \`script\` TOOL IS YOUR MAIN INTERFACE. ***\n` +
        `Most tasks should NOT be a chain of individual tool calls. The \`script\` tool runs ONE Luau program ` +
        `in the game that has a live \`mcp\` table bound to EVERY tool on this server. Inside the script you can:\n` +
        `  • Call any tool inline: \`local players = mcp.getPlayers()\`, ` +
        `\`local remotes = mcp.searchInstances({ className = "RemoteEvent" })\`, ` +
        `\`mcp.findFunctionsByName({ name = "buy" })\`. Tool names are camelCase of the kebab name, ` +
        `or use \`mcp.call("kebab-name", { ... })\`.\n` +
        `  • Look up the right arguments BEFORE calling an unfamiliar tool: ` +
        `\`mcp.help("get-players")\` returns \`{ signature, args[], example, ... }\`. ` +
        `With no name, \`mcp.help()\` lists every tool's compact signature. Never guess args — ask first.\n` +
        `  • Batch N independent calls into ONE round-trip with \`mcp.parallel({ a = function() return mcp.getPlayers() end, ` +
        `b = function() return mcp.searchInstances({ className = "RemoteEvent" }) end })\`.\n` +
        `  • Use \`game\`, \`workspace\`, and every in-game global at the same time — branch on a tool's result, ` +
        `read a property, return a derived value.\n` +
        `  • Globals you define persist across \`script\` calls (REPL-style). Use \`vm-reset\` to wipe.\n` +
        `Result is \`{ result, output }\` — \`print\`/\`warn\` inside the script are captured. Compose 10 steps ` +
        `into ONE call instead of 10 round-trips. \`run-luau\` is PURE Luau with no \`mcp\` table — only use it ` +
        `when your code is fully self-contained and doesn't need any other tool. If you prefer not to enter ` +
        `\`script\` mode at all, call the top-level \`tool-schema\` tool with \`{ name }\` (or \`{ search }\`) ` +
        `to get any tool's signature without writing Luau.`,
      `Beyond \`script\`, there are dedicated tools for signals & connections, metatables & closures, ` +
        `cross-references (xrefs), reverse-engineering & disassembly, memory scanning, remote spying, GUI, ` +
        `drawing, crypto, filesystem, networking/packets, and instrumentation. Before assuming something is ` +
        `impossible, call \`list-tools\` (no args for the category overview, or { category } / { search }) — ` +
        `there is very likely a purpose-built tool for it. Prefer the specific tool over hand-written Luau ` +
        `whenever one exists; reach for them from inside \`script\` as \`mcp.<name>(...)\` to combine them.`,
      `When several games are connected, select one first (list-clients / select-client), or use \`script-fanout\` ` +
        `to run the same script across N clients in parallel. Most tools degrade cleanly with { error } when a ` +
        `capability is missing from the executor, so it is safe to probe.`,
    ].join("\n\n");
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
            content: [{ type: "text" as const, text: safeStringify(result.data) }],
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

  /**
   * `suggest-tools` ranks tools matching a keyword by past success — a tiny
   * lifetime co-occurrence score that nudges the AI toward known-good chains
   * without an embedding pipeline. Tools the server has never run yet still
   * appear (no history => no penalty) but are ranked below proven ones.
   */
  private registerSuggestTools(server: McpServer): void {
    const input = z.object({
      keyword: z
        .string()
        .min(1)
        .describe("Keyword to match across each tool's name, title, and description."),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Maximum tools to return, default 10."),
      category: z
        .string()
        .optional()
        .describe("Optional: restrict to one category."),
    });

    server.registerTool(
      "suggest-tools",
      {
        title: "Suggest tools for a keyword, ranked by past success",
        description:
          "Surface the right tool faster by searching the catalog with a keyword and ranking results by past " +
          "runs and success ratio. Pure local heuristic: tools that have been called successfully many times " +
          "before float above untouched ones. Pass { keyword } (required), { limit } (default 10), and " +
          "optional { category }. Use this when you suspect a tool exists but `list-tools` is too noisy.",
        inputSchema: input.shape,
        annotations: { title: "Suggest tools ranked by past success", readOnlyHint: true },
      },
      async (args: z.infer<typeof input>) => {
        const data = this.runSuggestTools(args.keyword, args.limit, args.category);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          isError: false,
        };
      },
    );
  }

  private runSuggestTools(keyword: string, limit?: number, category?: string): unknown {
    const { registry, activity } = this.deps;
    const stats = new Map(activity.perToolStats().map((s) => [s.tool, s]));
    const term = keyword.toLowerCase();
    const matches = registry
      .list()
      .filter((tool) => (category ? tool.category === category : true))
      .filter(
        (tool) =>
          tool.name.toLowerCase().includes(term) ||
          tool.title.toLowerCase().includes(term) ||
          tool.description.toLowerCase().includes(term),
      )
      .map((tool) => {
        const s = stats.get(tool.name);
        const runs = s?.runs ?? 0;
        const errors = s?.errors ?? 0;
        const successRatio = runs > 0 ? (runs - errors) / runs : 0;
        // Score: name match dominates, then bias by past success * log(runs+1).
        const nameHit = tool.name.toLowerCase().includes(term) ? 100 : 0;
        const titleHit = tool.title.toLowerCase().includes(term) ? 25 : 0;
        const successScore = successRatio * Math.log10(runs + 1) * 50;
        const score = nameHit + titleHit + successScore;
        return {
          name: tool.name,
          title: tool.title,
          category: tool.category,
          runs,
          errors,
          successRatio: Math.round(successRatio * 1000) / 1000,
          score: Math.round(score * 10) / 10,
        };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit ?? 10);

    return { keyword, ...(category ? { category } : {}), count: matches.length, tools: matches };
  }
}
