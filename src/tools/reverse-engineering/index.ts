import type { Tool } from "../../application/tool/tool.js";
import { reBatchA } from "./_batch-a.js";
import { reBatchB } from "./_batch-b.js";
import { reBatchC } from "./_batch-c.js";

/** Every Reverse Engineering tool (the reverse-pack split + standalone GC tools). */
export const reverseEngineeringTools: Tool[] = [...reBatchA, ...reBatchB, ...reBatchC];
