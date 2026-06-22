import type { Tool } from "../../application/tool/tool.js";

import runLuau from "./run-luau.js";
import evalExpression from "./eval-expression.js";
import execute from "./execute.js";
import executeAndWait from "./execute-and-wait.js";
import batchExecute from "./batch-execute.js";
import profileCode from "./profile-code.js";
import measureMemory from "./measure-memory.js";
import runLoop from "./run-loop.js";
import runDeferred from "./run-deferred.js";
import runWithTimeout from "./run-with-timeout.js";
import executeFile from "./execute-file.js";
import script from "./script.js";
import vmReset from "./vm-reset.js";

/** Every tool in the Execution category. */
export const executionTools: Tool[] = [
  runLuau,
  evalExpression,
  execute,
  executeAndWait,
  batchExecute,
  profileCode,
  measureMemory,
  runLoop,
  runDeferred,
  runWithTimeout,
  executeFile,
  script,
  vmReset,
];
