import type { Tool } from "../../application/tool/tool.js";
import listGcTables from "./list-gc-tables.js";
import listGcThreads from "./list-gc-threads.js";
import listRegistryObjects from "./list-registry-objects.js";
import inspectInstanceMetatable from "./inspect-instance-metatable.js";
import listRuntimeModules from "./list-runtime-modules.js";
import findModuleScripts from "./find-module-scripts.js";
import getModuleSource from "./get-module-source.js";
import traceRequireCallers from "./trace-require-callers.js";
import findEventConnections from "./find-event-connections.js";
import scanRemoteListeners from "./scan-remote-listeners.js";
import findConstantsXref from "./find-constants-xref.js";
import findUpvalueXref from "./find-upvalue-xref.js";

/** Reverse Engineering — reverse-pack batch A (12 read-only runtime scans). */
export const reBatchA: Tool[] = [
  listGcTables,
  listGcThreads,
  listRegistryObjects,
  inspectInstanceMetatable,
  listRuntimeModules,
  findModuleScripts,
  getModuleSource,
  traceRequireCallers,
  findEventConnections,
  scanRemoteListeners,
  findConstantsXref,
  findUpvalueXref,
];
