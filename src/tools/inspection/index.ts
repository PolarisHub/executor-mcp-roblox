import type { Tool } from "../../application/tool/tool.js";

import getInstanceTree from "./get-instance-tree.js";
import getInstanceProperties from "./get-instance-properties.js";
import getScriptContent from "./get-script-content.js";
import getConsoleOutput from "./get-console-output.js";
import searchInstances from "./search-instances.js";
import scriptGrep from "./script-grep.js";
import listAttributes from "./list-attributes.js";
import verifyPathExists from "./verify-path-exists.js";
import watchInstanceProperty from "./watch-instance-property.js";
import listInstanceSignals from "./list-instance-signals.js";
import traceConnectionFunction from "./trace-connection-function.js";
import diffInstanceSnapshot from "./diff-instance-snapshot.js";

/** Every tool in the "Inspection" category, in registration order. */
export const inspectionTools: Tool[] = [
  getInstanceTree,
  getInstanceProperties,
  getScriptContent,
  getConsoleOutput,
  searchInstances,
  scriptGrep,
  listAttributes,
  verifyPathExists,
  watchInstanceProperty,
  listInstanceSignals,
  traceConnectionFunction,
  diffInstanceSnapshot,
];
