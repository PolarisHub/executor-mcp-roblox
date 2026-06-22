import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "clear-semantic-index",
  title: "Clear the semantic script index",
  description:
    "Drop the cached semantic index for THIS session's active client. This clears a SERVER-SIDE embedding cache " +
    "only — it does not touch the game or any live script. Resolves the active client from this session's " +
    "selection; if one is resolved its index is cleared, otherwise nothing happens. Use it to force the next " +
    "semantic-search-scripts call to re-harvest and re-embed from scratch (e.g. after the game's scripts changed).",
  category: "Semantic Search",
  input: z.object({}),
  requiresClient: false,
  mutatesState: false,
  async execute(_input, ctx) {
    const resolution = ctx.session.resolve();
    if (resolution.status !== "resolved") {
      return { data: { cleared: false }, summary: "No active client — nothing to clear." };
    }
    ctx.semantic.clear(resolution.client.id);
    return { data: { cleared: true }, summary: "Semantic index cleared for the active client." };
  },
});
