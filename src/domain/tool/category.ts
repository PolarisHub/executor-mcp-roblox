/**
 * The fixed set of tool categories. Categories are a domain concept: they define
 * how the toolkit is organized and searched, independent of any UI or transport.
 */
export const TOOL_CATEGORIES = [
  "Diagnostics",
  "Session & Client",
  "Execution",
  "Inspection",
  "Actions",
  "Reverse Engineering",
  "Disassembly & Xrefs",
  "Signals & Connections",
  "Metatables & Closures",
  "Remote Spy",
  "Actors & Hidden",
  "Memory Scan",
  "Instrumentation",
  "GUI",
  "Filesystem",
  "Crypt",
  "Drawing",
  "Network",
  "Utility",
  "Intelligence",
  "Semantic Search",
  "Windows",
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export function isToolCategory(value: string): value is ToolCategory {
  return (TOOL_CATEGORIES as readonly string[]).includes(value);
}
