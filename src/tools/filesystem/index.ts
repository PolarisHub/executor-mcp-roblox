import type { Tool } from "../../application/tool/tool.js";

import readFile from "./read-file.js";
import writeFile from "./write-file.js";
import appendFile from "./append-file.js";
import listFiles from "./list-files.js";
import makeFolder from "./make-folder.js";
import deleteFile from "./delete-file.js";
import deleteFolder from "./delete-folder.js";
import fileExists from "./file-exists.js";
import loadFile from "./load-file.js";
import getCustomAsset from "./get-custom-asset.js";

/** Every tool in the Filesystem category (executor-side workspace file I/O). */
export const filesystemTools: Tool[] = [
  readFile,
  writeFile,
  appendFile,
  listFiles,
  makeFolder,
  deleteFile,
  deleteFolder,
  fileExists,
  loadFile,
  getCustomAsset,
];
