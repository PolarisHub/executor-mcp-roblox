import type { Tool } from "../../application/tool/tool.js";

import listSignalConnections from "./list-signal-connections.js";
import getConnectionInfo from "./get-connection-info.js";
import getSignalArguments from "./get-signal-arguments.js";
import countSignalConnections from "./count-signal-connections.js";
import getConnectionConstants from "./get-connection-constants.js";
import getSignalArgumentsInfo from "./get-signal-arguments-info.js";
import replicateSignal from "./replicate-signal.js";
import findInstancesWithConnections from "./find-instances-with-connections.js";
import getConnectionUpvalues from "./get-connection-upvalues.js";
import canSignalReplicate from "./can-signal-replicate.js";
import fireConnection from "./fire-connection.js";
import getConnectionProtos from "./get-connection-protos.js";
import scanConnectionsBySource from "./scan-connections-by-source.js";
import setConnectionState from "./set-connection-state.js";
import getSignalWhitelist from "./get-signal-whitelist.js";
import fireSignal from "./fire-signal.js";

/** Every tool in the Signals & Connections category, in migration order. */
export const signalsTools: Tool[] = [
  listSignalConnections,
  getConnectionInfo,
  getSignalArguments,
  countSignalConnections,
  getConnectionConstants,
  getSignalArgumentsInfo,
  replicateSignal,
  findInstancesWithConnections,
  getConnectionUpvalues,
  canSignalReplicate,
  fireConnection,
  getConnectionProtos,
  scanConnectionsBySource,
  setConnectionState,
  getSignalWhitelist,
  fireSignal,
];
