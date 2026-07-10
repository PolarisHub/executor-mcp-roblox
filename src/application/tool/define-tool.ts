import type { z } from "zod";
import type { ToolCategory } from "../../domain/tool/category.js";
import type { Tool, ToolContext, ToolResult, ToolContract } from "./tool.js";
import { inferToolContract } from "./tool-contract.js";

/**
 * Authoring helper that infers a tool's input type from its zod schema, so a tool
 * file never restates its argument types. This is the one and only way tools are
 * declared, which keeps every tool uniform.
 *
 * @example
 * export default defineTool({
 *   name: "get-health",
 *   category: "Inspection",
 *   input: z.object({ path: z.string() }),
 *   async execute({ path }, ctx) {
 *     const hp = await ctx.runLuau(`return ${path}.Health`);
 *     return { data: { hp } };
 *   },
 * });
 */
export function defineTool<S extends z.ZodType>(definition: {
  name: string;
  title?: string;
  description: string;
  category: ToolCategory;
  input: S;
  requiresClient?: boolean;
  mutatesState?: boolean;
  ai?: Partial<ToolContract>;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}): Tool<z.infer<S>> {
  const base = {
    name: definition.name,
    title: definition.title ?? definition.name,
    description: definition.description,
    category: definition.category,
    // zod v4's ZodType is invariant in its internals; the schema's output is
    // z.infer<S> by construction, so this narrowing is sound.
    input: definition.input as unknown as z.ZodType<z.infer<S>>,
    requiresClient: definition.requiresClient ?? true,
    mutatesState: definition.mutatesState ?? false,
    execute: definition.execute,
  };
  const inferred = inferToolContract(base);
  return {
    ...base,
    ai: definition.ai ? { ...inferred, ...definition.ai } : inferred,
  };
}
