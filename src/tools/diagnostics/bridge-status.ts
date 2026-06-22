import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { toClientView, toResolutionView } from "../_shared/client-view.js";

export default defineTool({
  name: "bridge-status",
  title: "Bridge & multi-session status",
  description:
    "Report the bridge/session state as seen from this MCP session, WITHOUT touching any game. Shows: this session's " +
    "{ id, label, selection }; which client this session currently resolves to after applying its selection (the " +
    "active client, or why none resolves); and the full roster of connected Roblox executor clients (clientId, " +
    "username, userId, placeId, executor). Use this to debug multi-session routing — e.g. to confirm that your " +
    "session and another session are pointed at different games, or to see whether any client is connected at all. " +
    "Returns { session, active, clients } and never runs Luau.",
  category: "Diagnostics",
  requiresClient: false,
  input: z.object({}),
  async execute(_input, ctx) {
    const session = {
      id: ctx.session.id,
      label: ctx.session.label,
      selection: ctx.session.selection,
    };
    const active = toResolutionView(ctx.session.resolve());
    const clients = ctx.clients.list().map((client) => {
      const view = toClientView(client);
      return {
        clientId: view.clientId,
        username: view.username,
        userId: view.userId,
        placeId: view.placeId,
        executor: view.executor,
      };
    });

    const summary =
      clients.length === 0
        ? `Session ${session.label}: no Roblox clients connected.`
        : `Session ${session.label}: ${clients.length} client(s) connected; resolves to ${
            active.status === "resolved" ? active.client.clientId : active.status
          }.`;

    return { data: { session, active, clients }, summary };
  },
});
