import type { Tool } from "../../application/tool/tool.js";

import setInstanceProperty from "./set-instance-property.js";
import setAttribute from "./set-attribute.js";
import setPropertiesBulk from "./set-properties-bulk.js";
import createInstance from "./create-instance.js";
import cloneInstance from "./clone-instance.js";
import destroyInstance from "./destroy-instance.js";
import invokeMethod from "./invoke-method.js";
import fireRemote from "./fire-remote.js";
import dumpTable from "./dump-table.js";
import getThreadStack from "./get-thread-stack.js";

/** Every tool in the Actions category, in migration order. */
export const actionsTools: Tool[] = [
  setInstanceProperty,
  setAttribute,
  setPropertiesBulk,
  createInstance,
  cloneInstance,
  destroyInstance,
  invokeMethod,
  fireRemote,
  dumpTable,
  getThreadStack,
];
