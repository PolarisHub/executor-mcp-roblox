import type { Tool } from "../../application/tool/tool.js";

import listRobloxWindows from "./list-roblox-windows.js";
import screenshotWindow from "./screenshot-window.js";

/** Every tool in the Windows category (server-host OS window operations). */
export const windowsTools: Tool[] = [listRobloxWindows, screenshotWindow];
