import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { toResolutionView } from "../_shared/client-view.js";

export default defineTool({
  name: "get-active-client",
  title: "Show which Roblox client this session targets",
  description:
    "Report which live Roblox client THIS session currently resolves to (read-only), including its current " +
    "selection and whether resolution is ambiguous or offline. Use it to confirm routing before running code, " +
    "especially when multiple games are connected or after a rejoin.",
  category: "Session & Client",
  input: z.object({}),
  requiresClient: false,
  async execute(_input, ctx) {
    const resolution = toResolutionView(ctx.session.resolve());
    const summary =
      resolution.status === "resolved"
        ? `Targeting ${resolution.client.username ?? resolution.client.clientId}.`
        : resolution.status === "ambiguous"
          ? `Ambiguous — ${resolution.candidates.length} accounts connected; run select-client.`
          : resolution.reason === "no-clients"
            ? "No clients connected."
            : "Selected client is offline.";

    return {
      data: { selection: ctx.session.selection, resolution },
      summary,
    };
  },
});
