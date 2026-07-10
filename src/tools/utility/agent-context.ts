import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { toClientView, toResolutionView } from "../_shared/client-view.js";

export default defineTool({
  name: "agent-context",
  title: "Build a live context brief for the AI agent",
  description:
    "READ-ONLY. Bootstrap an AI agent with the current MCP/session/game context in one call. Returns connected " +
    "clients, this session's active selection resolution, game identity, executor identity/capabilities, and " +
    "actionable next steps. Use this at the start of a task or after a reconnect instead of separately guessing " +
    "which client, place, executor, or capability set is active. If multiple clients are connected, the brief tells " +
    "you to select one; it never silently chooses between distinct accounts. Optional capability probing is safe but " +
    "slower. The tool never mutates game state.",
  category: "Utility",
  requiresClient: false,
  input: z.object({
    includeGameInfo: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include PlaceId/JobId/game metadata when this session resolves to a client."),
    includeExecutorInfo: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include executor identity and headline capability flags when a client is active."),
    includeCapabilities: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run the larger side-effect-free capability matrix probe; slower but useful for planning advanced tools.",
      ),
    includeHistory: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include a compact tail of this session's successful/failed tool history."),
    historyLimit: z.number().int().positive().max(50).optional().default(12),
    includeMemory: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include recent persistent agent-memory entries for continuity across tasks."),
    memoryLimit: z.number().int().positive().max(50).optional().default(8),
  }),
  async execute(
    {
      includeGameInfo,
      includeExecutorInfo,
      includeCapabilities,
      includeHistory,
      historyLimit,
      includeMemory,
      memoryLimit,
    },
    ctx,
  ) {
    const clients = ctx.clients.list().map(toClientView);
    const active = toResolutionView(ctx.session.resolve());
    const observations: Record<string, unknown> = {};
    const recommendations: string[] = [];

    if (includeHistory) {
      const records = await ctx.sessionLogger.read(ctx.session.id);
      observations["history"] = records.slice(-historyLimit).map((record) => ({
        seq: record.seq,
        tool: record.tool,
        elapsedMs: record.elapsedMs,
        clientId: record.clientId,
        outcome: record.error ? "error" : "ok",
        ...(record.error ? { error: record.error } : {}),
      }));
    }
    if (includeMemory) {
      const memories = await ctx.playbooks.list({ tag: "agent-memory" });
      observations["memory"] = memories.slice(0, memoryLimit).map((memory) => ({
        name: memory.name,
        description: memory.description,
        tags: memory.tags,
        updatedAt: memory.updatedAt,
      }));
    }

    if (clients.length === 0) {
      recommendations.push(
        "Connect a Roblox executor client by running the connector loader, then call agent-context again.",
      );
    } else if (active.status === "ambiguous") {
      recommendations.push(
        "Call select-client with the intended client/account before using client-bound tools.",
      );
    } else if (active.status === "none") {
      recommendations.push(
        "The pinned client is offline; refresh with list-clients and select a connected client.",
      );
    } else {
      recommendations.push(
        "The session has an active client. Confirm game identity before place-specific actions.",
      );
      const read = async (name: string): Promise<unknown> => {
        try {
          const result = await ctx.invokeTool(name, {});
          return { data: result.data, ...(result.summary ? { summary: result.summary } : {}) };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      };

      const pending: Promise<void>[] = [];
      if (includeGameInfo) {
        pending.push(
          read("get-game-info").then((value) => {
            observations["game"] = value;
          }),
        );
      }
      if (includeExecutorInfo) {
        pending.push(
          read("get-executor-info").then((value) => {
            observations["executor"] = value;
          }),
        );
      }
      if (includeCapabilities) {
        pending.push(
          read("test-capabilities").then((value) => {
            observations["capabilities"] = value;
          }),
        );
      }
      await Promise.all(pending);
      recommendations.push(
        "Use tool-plan with the user's goal, then follow a discover→act→verify workflow.",
      );
      recommendations.push(
        "Use tool-schema on any selected tool whose required fields are not already obvious.",
      );
    }

    return {
      data: {
        session: { id: ctx.session.id, label: ctx.session.label },
        clients,
        active,
        observations,
        recommendations,
        readyForClientTools: active.status === "resolved",
      },
      summary:
        clients.length === 0
          ? "No Roblox clients connected."
          : active.status === "resolved"
            ? `Context loaded for ${active.client.username ?? active.client.clientId}.`
            : `Context loaded; client selection is ${active.status}.`,
    };
  },
});
