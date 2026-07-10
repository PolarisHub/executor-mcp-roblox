import type { Tool } from "../../application/tool/tool.js";

import observeWorld from "./observe-world.js";
import resolveEntity from "./resolve-entity.js";
import smartTask from "./smart-task.js";
import assertState from "./assert-state.js";
import explainFailure from "./explain-failure.js";
import stateTransaction from "./state-transaction.js";
import teachMode from "./teach-mode.js";
import worldDelta from "./world-delta.js";

/** Grounded perception, adaptive execution, verification, recovery, and learning tools. */
export const intelligenceTools: Tool[] = [
  observeWorld,
  resolveEntity,
  smartTask,
  assertState,
  explainFailure,
  stateTransaction,
  teachMode,
  worldDelta,
];
