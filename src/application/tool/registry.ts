import { TOOL_CATEGORIES, type ToolCategory } from "../../domain/tool/category.js";
import type { Tool } from "./tool.js";

/**
 * In-memory catalog of registered tools. Built once at startup from the tool
 * modules and queried by the MCP adapter and the `list-tools` discovery tool.
 * Rejects duplicate names so a copy-paste mistake fails loudly at boot.
 */
export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.byName.has(tool.name)) {
      throw new Error(`Duplicate tool registration: "${tool.name}"`);
    }
    this.byName.set(tool.name, tool);
  }

  registerAll(tools: Iterable<Tool>): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  list(): readonly Tool[] {
    return [...this.byName.values()];
  }

  byCategory(category: ToolCategory): readonly Tool[] {
    return this.list().filter((tool) => tool.category === category);
  }

  /** Count of tools per category, in canonical category order. */
  categoryCounts(): readonly { category: ToolCategory; count: number }[] {
    return TOOL_CATEGORIES.map((category) => ({
      category,
      count: this.byCategory(category).length,
    })).filter((entry) => entry.count > 0);
  }

  get size(): number {
    return this.byName.size;
  }
}
