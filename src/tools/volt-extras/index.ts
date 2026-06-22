import type { Tool } from "../../application/tool/tool.js";

import filterGc from "./filter-gc.js";
import getCallStack from "./get-call-stack.js";
import getStack from "./get-stack.js";
import getHiddenUi from "./get-hidden-ui.js";
import listRenderedInstances from "./list-rendered-instances.js";
import cacheInvalidate from "./cache-invalidate.js";
import cacheIsCached from "./cache-is-cached.js";
import cacheReplace from "./cache-replace.js";
import getScriptBytecode from "./get-script-bytecode.js";
import getScriptHash from "./get-script-hash.js";

/**
 * Volt/UNC "extras" that fold into existing categories: high-value executor
 * functions (filtergc, debug.getstack, gethui, getrendered, the cache library)
 * exposed as focused tools. Each tool sets its own category explicitly and guards
 * its executor function, so the set degrades cleanly on non-Volt executors.
 */
export const voltExtrasTools: Tool[] = [
  filterGc,
  getCallStack,
  getStack,
  getHiddenUi,
  listRenderedInstances,
  cacheInvalidate,
  cacheIsCached,
  cacheReplace,
  getScriptBytecode,
  getScriptHash,
];
