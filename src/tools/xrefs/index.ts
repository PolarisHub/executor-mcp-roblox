import type { Tool } from "../../application/tool/tool.js";

import listStrings from "./list-strings.js";
import findStringXrefs from "./find-string-xrefs.js";
import findGlobalXrefs from "./find-global-xrefs.js";
import findFunctionsByComplexity from "./find-functions-by-complexity.js";
import findFunctionXrefs from "./find-function-xrefs.js";
import findInstanceXrefs from "./find-instance-xrefs.js";
import findRemoteXrefs from "./find-remote-xrefs.js";
import buildCallGraph from "./build-call-graph.js";
import disassembleFunction from "./disassemble-function.js";
import findDuplicateFunctions from "./find-duplicate-functions.js";
import searchBytecode from "./search-bytecode.js";
import findUpvalueSharing from "./find-upvalue-sharing.js";

/** Every tool in the "Disassembly & Xrefs" category, in registration order. */
export const xrefsTools: Tool[] = [
  listStrings,
  findStringXrefs,
  findGlobalXrefs,
  findFunctionsByComplexity,
  findFunctionXrefs,
  findInstanceXrefs,
  findRemoteXrefs,
  buildCallGraph,
  disassembleFunction,
  findDuplicateFunctions,
  searchBytecode,
  findUpvalueSharing,
];
