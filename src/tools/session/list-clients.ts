import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { toClientView, toResolutionView } from "../_shared/client-view.js";

export default defineTool({
  name: "list-clients",
  title: "List connected Roblox clients",
  description:
    "List every connected Roblox executor client with its clientId, account, place, and executor. " +
    "Also reports which client THIS session currently resolves to (after applying its selection). " +
    "Call this before select-client when more than one client is connected or the target is unknown.",
  category: "Session & Client",
  input: z.object({}),
  requiresClient: false,
  async execute(_input, ctx) {
    const clients = ctx.clients.list().map(toClientView);
    const active = toResolutionView(ctx.session.resolve());

    const summary =
      clients.length === 0
        ? "No Roblox clients are connected. Run the loader in your executor first."
        : `${clients.length} client(s) connected; this session resolves to ${
            active.status === "resolved" ? active.client.clientId : active.status
          }.`;

    return { data: { clients, active }, summary };
  },
});
