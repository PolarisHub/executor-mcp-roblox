import type { Tool } from "../../application/tool/tool.js";

import hookAndLogFunction from "./hook-and-log-function.js";
import callClosure from "./call-closure.js";
import countFunctionCalls from "./count-function-calls.js";
import spoofFunctionReturn from "./spoof-function-return.js";
import blockFunction from "./block-function.js";
import traceCallDurations from "./trace-call-durations.js";
import captureLogOutput from "./capture-log-output.js";
import watchPropertyChanges from "./watch-property-changes.js";

/** Every tool in the Instrumentation category, in migration order. */
export const instrumentationTools: Tool[] = [
  hookAndLogFunction,
  callClosure,
  countFunctionCalls,
  spoofFunctionReturn,
  blockFunction,
  traceCallDurations,
  captureLogOutput,
  watchPropertyChanges,
];
