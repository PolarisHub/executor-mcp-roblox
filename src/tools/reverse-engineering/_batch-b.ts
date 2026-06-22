import type { Tool } from "../../application/tool/tool.js";
import scanProtoFunctions from "./scan-proto-functions.js";
import getFunctionProtos from "./get-function-protos.js";
import dumpFunctionEnv from "./dump-function-env.js";
import listGlobalEnvKeys from "./list-global-env-keys.js";
import scanHookSurfaces from "./scan-hook-surfaces.js";
import scanNetworkEndpoints from "./scan-network-endpoints.js";
import findPathReferences from "./find-path-references.js";
import listScriptActors from "./list-script-actors.js";
import findBytecodeSizeOutliers from "./find-bytecode-size-outliers.js";
import scanClosuresBySource from "./scan-closures-by-source.js";
import scanClosuresByName from "./scan-closures-by-name.js";
import summarizeRuntimeSurfaces from "./summarize-runtime-surfaces.js";

export const reBatchB: Tool[] = [
  scanProtoFunctions,
  getFunctionProtos,
  dumpFunctionEnv,
  listGlobalEnvKeys,
  scanHookSurfaces,
  scanNetworkEndpoints,
  findPathReferences,
  listScriptActors,
  findBytecodeSizeOutliers,
  scanClosuresBySource,
  scanClosuresByName,
  summarizeRuntimeSurfaces,
];
