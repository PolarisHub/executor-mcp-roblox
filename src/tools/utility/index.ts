import type { Tool } from "../../application/tool/tool.js";

import getFastFlag from "./get-fast-flag.js";
import setFastFlag from "./set-fast-flag.js";
import getFpsCap from "./get-fps-cap.js";
import setFpsCap from "./set-fps-cap.js";
import getHwid from "./get-hwid.js";
import setClipboard from "./set-clipboard.js";
import queueOnTeleport from "./queue-on-teleport.js";
import clearQueueOnTeleport from "./clear-queue-on-teleport.js";
import saveInstance from "./save-instance.js";
import messageBox from "./message-box.js";
import toolSchema from "./tool-schema.js";
import toolPlan from "./tool-plan.js";
import agentContext from "./agent-context.js";
import agentRun from "./agent-run.js";
import agentMemory from "./agent-memory.js";
import toolQualityAudit from "./tool-quality-audit.js";

/** Miscellaneous executor utilities (FastFlags, FPS cap, HWID, clipboard, teleport queue, saveinstance, messagebox). */
export const utilityTools: Tool[] = [
  getFastFlag,
  setFastFlag,
  getFpsCap,
  setFpsCap,
  getHwid,
  setClipboard,
  queueOnTeleport,
  clearQueueOnTeleport,
  saveInstance,
  messageBox,
  toolSchema,
  toolPlan,
  agentContext,
  agentRun,
  agentMemory,
  toolQualityAudit,
];
