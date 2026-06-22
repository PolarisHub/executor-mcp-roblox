import type { Tool } from "../../application/tool/tool.js";

import findTablesByKey from "./find-tables-by-key.js";
import scanNumberRange from "./scan-number-range.js";
import readPathValue from "./read-path-value.js";
import writePathValue from "./write-path-value.js";
import findTableReferences from "./find-table-references.js";
import findStringInTables from "./find-string-in-tables.js";
import searchGcValue from "./search-gc-value.js";
import watchValue from "./watch-value.js";

/** Every tool in the Memory Scan category, in migration order. */
export const memoryScanTools: Tool[] = [
  findTablesByKey,
  scanNumberRange,
  readPathValue,
  writePathValue,
  findTableReferences,
  findStringInTables,
  searchGcValue,
  watchValue,
];
