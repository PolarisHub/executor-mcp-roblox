import type { Tool } from "../../application/tool/tool.js";

import semanticSearchScripts from "./semantic-search-scripts.js";
import getSemanticIndexStats from "./get-semantic-index-stats.js";
import clearSemanticIndex from "./clear-semantic-index.js";

/** Every tool in the "Semantic Search" category, in registration order. */
export const semanticTools: Tool[] = [
  semanticSearchScripts,
  getSemanticIndexStats,
  clearSemanticIndex,
];
