import type { z } from "zod";
import type { ToolCategory } from "../../domain/tool/category.js";

/**
 * A read-only, schema-aware view of the tool catalog, intended for tools that
 * introspect the surface (e.g. `tool-schema`). Distinct from the
 * {@link ToolRegistry} class so introspection tools depend on a port rather
 * than reach into infrastructure for the live registry.
 */
export interface ToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly mutatesState: boolean;
  readonly requiresClient: boolean;
  readonly input: z.ZodTypeAny;
}

export interface ToolDirectory {
  /** Every registered tool, in stable registration order. */
  list(): readonly ToolDescriptor[];
  /** Lookup by exact kebab-case name. Returns null when unknown. */
  find(name: string): ToolDescriptor | null;
}
