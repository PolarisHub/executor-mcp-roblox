import type { Tool } from "../../application/tool/tool.js";
import getExecutorInfo from "./get-executor-info.js";
import getGameInfo from "./get-game-info.js";
import testCapabilities from "./test-capabilities.js";
import getAnticheatSurfaces from "./get-anticheat-surfaces.js";
import executionFootprintAudit from "./execution-footprint-audit.js";
import getInstanceCounts from "./get-instance-counts.js";
import getMemoryStats from "./get-memory-stats.js";
import getRenderStats from "./get-render-stats.js";
import bridgeStatus from "./bridge-status.js";
import getConnectorDiagnostics from "./get-connector-diagnostics.js";
import sessionList from "./session-list.js";
import sessionShow from "./session-show.js";
import sessionReplay from "./session-replay.js";

/** Every Diagnostics tool (Wave 0 exemplars + the migrated census/recon set). */
export const diagnosticsTools: Tool[] = [
  getExecutorInfo,
  getGameInfo,
  testCapabilities,
  getAnticheatSurfaces,
  executionFootprintAudit,
  getInstanceCounts,
  getMemoryStats,
  getRenderStats,
  bridgeStatus,
  getConnectorDiagnostics,
  sessionList,
  sessionShow,
  sessionReplay,
];
