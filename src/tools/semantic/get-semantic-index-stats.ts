import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import type { SemanticStats } from "../../application/ports/semantic-index.js";

export default defineTool({
  name: "get-semantic-index-stats",
  title: "Semantic index statistics",
  description:
    "Report the semantic script index for THIS session's active client WITHOUT touching the game: whether anything " +
    "is indexed, how many documents are cached, and the embedding model + dimensions in use. Resolves the active " +
    "client from this session's selection; if no client is resolved it returns an empty, not-indexed summary. " +
    "Use it to confirm an index exists before searching, or to see which embeddings backend is active.",
  category: "Semantic Search",
  input: z.object({}),
  requiresClient: false,
  async execute(_input, ctx) {
    const resolution = ctx.session.resolve();
    if (resolution.status !== "resolved") {
      const data: SemanticStats = {
        indexed: false,
        documentCount: 0,
        model: null,
        dimensions: null,
      };
      return { data, summary: "No active client — nothing indexed." };
    }
    const stats = ctx.semantic.stats(resolution.client.id);
    const summary = stats.indexed
      ? `Indexed ${stats.documentCount} script(s) with ${stats.model ?? "unknown"}.`
      : "No scripts indexed yet for the active client.";
    return { data: stats, summary };
  },
});
