import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { toResolutionView } from "../_shared/client-view.js";

export default defineTool({
  name: "clear-selection",
  title: "Clear this session's client selection",
  description:
    "Drop THIS session's client binding so it no longer pins a specific client or account. Afterwards tools " +
    "auto-resolve: with exactly one client connected they use it; with several different accounts you must " +
    "select-client again. Use this to reset routing before re-selecting, or to hand control back to auto-resolution.",
  category: "Session & Client",
  input: z.object({}),
  requiresClient: false,
  async execute(_input, ctx) {
    ctx.session.clear();
    const resolution = toResolutionView(ctx.session.resolve());
    return {
      data: { cleared: true, resolution },
      summary: "Selection cleared.",
    };
  },
});
