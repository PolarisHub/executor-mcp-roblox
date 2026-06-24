import { z } from "zod";
import { zodToLuauType } from "./zod-luau-type.js";

/**
 * Walks a Zod input schema and surfaces per-field metadata — the field name,
 * its Luau-flavoured type, whether it is optional, and its `.describe()` text.
 *
 * Used in three places:
 *   - the `tool-schema` tool, so a script can introspect any other tool's
 *     argument shape at runtime (`mcp.toolSchema("get-players")`),
 *   - the dashboard's `mcp.d.luau` emitter, to embed per-field doc comments so
 *     editor hover shows the description on each argument,
 *   - the script preflight, when an unknown `mcp.<tool>` has a near-miss it
 *     can surface the suggestion's signature inline.
 *
 * Only top-level fields are walked; nested objects are emitted as compact Luau
 * type expressions via {@link zodToLuauType}.
 */

export interface InputField {
  /** Top-level key on the input object. */
  readonly name: string;
  /** Compact Luau type expression (suffix `?` indicates optional). */
  readonly type: string;
  /** True when the field is `.optional()`, `.nullable()`, or has a `.default()`. */
  readonly optional: boolean;
  /** `.describe()` text from the Zod node, or null when none was supplied. */
  readonly description: string | null;
}

function unwrap(node: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean } {
  if (node instanceof z.ZodOptional) return { inner: node.unwrap() as z.ZodTypeAny, optional: true };
  if (node instanceof z.ZodDefault) {
    const inner = (node as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
    return { inner, optional: true };
  }
  if (node instanceof z.ZodNullable) {
    const inner = (node as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
    return { inner, optional: true };
  }
  return { inner: node, optional: false };
}

function pickDescription(node: z.ZodTypeAny): string | null {
  // Zod v4 stores .describe(s) as { description: s } on the schema's metadata,
  // exposed as `node.description` (getter) and also via `node.meta()`. v3 used
  // `_def.description`. Cover both so a future downgrade doesn't break this.
  const v4Direct = (node as unknown as { description?: unknown }).description;
  if (typeof v4Direct === "string" && v4Direct.length > 0) return v4Direct;
  const v4Meta = (node as unknown as { meta?: () => { description?: unknown } | undefined }).meta?.();
  const fromMeta = v4Meta?.description;
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  const v3Def = (node as unknown as { _def?: { description?: unknown } })._def;
  const v3 = v3Def?.description;
  if (typeof v3 === "string" && v3.length > 0) return v3;
  const { inner } = unwrap(node);
  if (inner === node) return null;
  return pickDescription(inner);
}

export function describeInputFields(schema: z.ZodTypeAny): readonly InputField[] {
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodTypeAny>;
  const fields: InputField[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const { optional } = unwrap(value);
    let type: string;
    try {
      type = zodToLuauType(value);
    } catch {
      type = "any";
    }
    fields.push({
      name: key,
      type,
      optional,
      description: pickDescription(value),
    });
  }
  return fields;
}

/**
 * Produce a one-line Luau-style signature for an input object, e.g.
 * `{ limit: number?, includeBots: boolean? }`. Suitable for inline help or
 * error messages where multi-line per-field detail would be too much.
 */
export function inputSignature(schema: z.ZodTypeAny): string {
  const fields = describeInputFields(schema);
  if (fields.length === 0) return "{}";
  return `{ ${fields.map((f) => `${f.name}: ${f.type}`).join(", ")} }`;
}
