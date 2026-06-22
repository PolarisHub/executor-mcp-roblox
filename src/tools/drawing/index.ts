import type { Tool } from "../../application/tool/tool.js";

import drawCreate from "./draw-create.js";
import drawUpdate from "./draw-update.js";
import drawRemove from "./draw-remove.js";
import drawClear from "./draw-clear.js";
import listDrawings from "./list-drawings.js";

/** Every tool in the Drawing category (executor `Drawing` library overlays). */
export const drawingTools: Tool[] = [drawCreate, drawUpdate, drawRemove, drawClear, listDrawings];
