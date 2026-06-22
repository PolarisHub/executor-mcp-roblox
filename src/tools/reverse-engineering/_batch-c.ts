import type { Tool } from "../../application/tool/tool.js";

import listGcFunctions from "./list-gc-functions.js";
import lookupFunction from "./lookup-function.js";
import getFunctionUpvalues from "./get-function-upvalues.js";
import findFunctionsByConstant from "./find-functions-by-constant.js";
import compareGcSnapshots from "./compare-gc-snapshots.js";

/** Reverse Engineering — standalone batch C (getgc discovery / inspection). */
export const reBatchC: Tool[] = [
  listGcFunctions,
  lookupFunction,
  getFunctionUpvalues,
  findFunctionsByConstant,
  compareGcSnapshots,
];
