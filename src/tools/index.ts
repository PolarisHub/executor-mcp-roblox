import type { Tool } from "../application/tool/tool.js";

import { sessionTools } from "./session/index.js";
import { executionTools } from "./execution/index.js";
import { diagnosticsTools } from "./diagnostics/index.js";
import { inspectionTools } from "./inspection/index.js";
import { signalsTools } from "./signals/index.js";
import { metatablesTools } from "./metatables/index.js";
import { xrefsTools } from "./xrefs/index.js";
import { reverseEngineeringTools } from "./reverse-engineering/index.js";
import { actionsTools } from "./actions/index.js";
import { guiTools } from "./gui/index.js";
import { remoteSpyTools } from "./remote-spy/index.js";
import { instrumentationTools } from "./instrumentation/index.js";
import { actorsHiddenTools } from "./actors-hidden/index.js";
import { memoryScanTools } from "./memory-scan/index.js";
import { windowsTools } from "./windows/index.js";
import { semanticTools } from "./semantic/index.js";
import { filesystemTools } from "./filesystem/index.js";
import { cryptTools } from "./crypt/index.js";
import { drawingTools } from "./drawing/index.js";
import { voltExtrasTools } from "./volt-extras/index.js";
import { networkTools } from "./network/index.js";
import { utilityTools } from "./utility/index.js";
import { intelligenceTools } from "./intelligence/index.js";

/**
 * The single, ordered list of every built-in tool, one array per category. The
 * composition root passes this straight to {@link ToolRegistry.registerAll}.
 * Adding a category = import its array and spread it here; the registry rejects
 * duplicate names at boot.
 */
export function allTools(): Tool[] {
  return [
    ...sessionTools,
    ...executionTools,
    ...diagnosticsTools,
    ...inspectionTools,
    ...signalsTools,
    ...metatablesTools,
    ...xrefsTools,
    ...reverseEngineeringTools,
    ...actionsTools,
    ...guiTools,
    ...remoteSpyTools,
    ...instrumentationTools,
    ...actorsHiddenTools,
    ...memoryScanTools,
    ...windowsTools,
    ...semanticTools,
    ...filesystemTools,
    ...cryptTools,
    ...drawingTools,
    ...voltExtrasTools,
    ...networkTools,
    ...utilityTools,
    ...intelligenceTools,
  ];
}
