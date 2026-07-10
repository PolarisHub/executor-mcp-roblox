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
import { inputSignature } from "../../application/services/schema-introspect.js";
import { rankTools } from "../../application/services/tool-discovery.js";
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

function asStructuredContent(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
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
      `For ambiguous natural-language requests, call \`tool-plan\` with the user's goal first. It returns ` +
        `a discover→act→verify recipe, ranked alternatives, exact signatures, and mutation flags. Then call ` +
        `\`tool-schema\` for the chosen tool if any field is unclear. Use a disciplined loop: select the client, ` +
        `discover/read, act only after confirming the target and arguments, then verify the result. Treat every ` +
        `tool result as data: branch on \`ok\`, \`error\`, \`truncated\`, and capability warnings instead of ` +
        `assuming success. Keep outputs compact with limits and use \`mcp.parallel\` only for independent reads.`,
      `At the start of a task or after reconnects, call \`agent-context\` once. It reports connected clients, active ` +
        `selection, game identity, executor capabilities, and concrete next actions in one read-only brief. Do not ` +
        `assume the active place, JobId, executor, or capability set from an earlier task.`,
      `For closed-loop execution, use \`agent-run\` with explicit ordered steps. Start with \`dryRun:true\`; keep ` +
        `\`allowMutations:false\` until the target is confirmed. Pass earlier outputs forward with ` +
        `\`$steps.stepId.data.field\`, and let contract verifiers prove mutations. Store verified place-specific facts ` +
        `with \`agent-memory\`; never store secrets, tokens, or credentials.`,
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
    const contract = tool.ai;
    const contractHint = contract
      ? ` AI contract: phase=${contract.phase}; ` +
        `${contract.prerequisites.length ? `prerequisites=${contract.prerequisites.join(",")}; ` : ""}` +
        `${contract.verifiesWith.length ? `verifyWith=${contract.verifiesWith.join(",")}; ` : ""}` +
        `${contract.requiresCapabilities.length ? `capabilities=${contract.requiresCapabilities.join(",")}; ` : ""}` +
        `${contract.alternatives.length ? `alternatives=${contract.alternatives.join(",")}.` : ""}`
      : "";
    const description = `${tool.description}${tool.mutatesState ? MUTATES_NOTE : ""}${contractHint}`;
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
            content: [
              ...(result.summary
                ? [{ type: "text" as const, text: `Summary: ${result.summary}` }]
                : []),
              { type: "text" as const, text: safeStringify(result.data) },
            ],
            ...(asStructuredContent(result.data)
              ? { structuredContent: asStructuredContent(result.data) }
              : {}),
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
        .describe(
          "Natural-language goal or keyword matched with intent aliases across the tool catalog.",
        )
        .optional(),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Maximum detailed tool entries when category/search is used; default 50."),
    });

    server.registerTool(
      "list-tools",
      {
        title: "Browse/search this server's tools by category",
        description:
          "Discover the right tool without scanning all of them. Call with NO arguments to see every " +
          "category and its count plus the total. Pass { category } to list that category's tools, or " +
          "{ search } to rank tools against a natural-language goal. Results include signatures and safety flags. Reads the server's " +
          "own tool catalog (no game client required).",
        inputSchema: input.shape,
        annotations: { title: "Browse/search this server's tools", readOnlyHint: true },
      },
      async (args: z.infer<typeof input>) => {
        const data = this.runListTools(args.category, args.search, args.limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          isError: false,
        };
      },
    );
  }

  private runListTools(category?: string, search?: string, limit = 50): unknown {
    const { registry } = this.deps;

    if (!category && !search) {
      const counts = registry.categoryCounts();
      return {
        total: registry.size,
        categories: counts,
        hint: "Pass { category } to list a category's tools, or { search } to keyword-match.",
      };
    }

    const candidates = registry
      .list()
      .filter((tool) => (category ? tool.category === category : true));
    const ranked = search
      ? rankTools(search, candidates, limit)
      : candidates.slice(0, limit).map((tool) => ({
          tool,
          score: 0,
          matchedTerms: [],
          why: "Category listing.",
        }));
    const matches = ranked.map((entry) => ({
      name: entry.tool.name,
      title: entry.tool.title,
      category: entry.tool.category,
      signature: inputSignature(entry.tool.input),
      mutatesState: entry.tool.mutatesState === true,
      requiresClient: entry.tool.requiresClient !== false,
      ai: entry.tool.ai,
      ...(search ? { score: Math.round(entry.score * 10) / 10, why: entry.why } : {}),
    }));

    return {
      ...(category ? { category } : {}),
      ...(search ? { search } : {}),
      count: matches.length,
      tools: matches,
      hint: "Call tool-schema with { name } for full field descriptions and an invocation example.",
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
        .describe(
          "Natural-language goal or keyword, e.g. 'find the player's money' or 'click a UI button'.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Maximum tools to return, default 10."),
      category: z.string().optional().describe("Optional: restrict to one category."),
    });

    server.registerTool(
      "suggest-tools",
      {
        title: "Suggest tools for a keyword, ranked by past success",
        description:
          "Surface the right tool faster from a natural-language goal. Uses intent aliases and field-aware ranking, " +
          "then adds a small past-success bias so tools that have worked in this server session float above equally " +
          "relevant untouched tools. Returns exact signatures, mutation/client flags, match reasons, and usage stats. " +
          "Pass { keyword } (required), { limit } (default 10), and optional { category }.",
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
    const candidates = registry
      .list()
      .filter((tool) => (category ? tool.category === category : true));
    const matches = rankTools(keyword, candidates, 50)
      .map((entry) => {
        const s = stats.get(entry.tool.name);
        const runs = s?.runs ?? 0;
        const errors = s?.errors ?? 0;
        const successRatio = runs > 0 ? (runs - errors) / runs : 0;
        const successScore = successRatio * Math.log10(runs + 1) * 50;
        const score = entry.score + successScore;
        return {
          name: entry.tool.name,
          title: entry.tool.title,
          category: entry.tool.category,
          signature: inputSignature(entry.tool.input),
          mutatesState: entry.tool.mutatesState === true,
          requiresClient: entry.tool.requiresClient !== false,
          ai: entry.tool.ai,
          runs,
          errors,
          successRatio: Math.round(successRatio * 1000) / 1000,
          matchedTerms: entry.matchedTerms,
          why: entry.why,
          score: Math.round(score * 10) / 10,
        };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit ?? 10);

    return { keyword, ...(category ? { category } : {}), count: matches.length, tools: matches };
  }
}
