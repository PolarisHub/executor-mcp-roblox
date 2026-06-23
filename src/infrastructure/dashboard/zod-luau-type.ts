import { z } from "zod";

/**
 * Tiny Zod → Luau type expression converter. Mirrors the JSON-Schema converter
 * shape but emits Luau type-alias syntax, so editors with Luau LSP get real
 * autocomplete and hover docs on the `mcp.*` surface from any file (not just
 * the in-browser REPL). Unhandled shapes degrade to `any` so a new tool author
 * never breaks the emitter.
 */

function unwrap(node: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean } {
  if (node instanceof z.ZodOptional) {
    return { inner: node.unwrap() as z.ZodTypeAny, optional: true };
  }
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

function escapeLuauString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function zodToLuauType(schema: z.ZodTypeAny): string {
  try {
    return inner(schema);
  } catch {
    return "any";
  }
}

function inner(schema: z.ZodTypeAny): string {
  const { inner: u, optional } = unwrap(schema);
  const base = convert(u);
  return optional ? `${base}?` : base;
}

function convert(node: z.ZodTypeAny): string {
  if (node instanceof z.ZodString) return "string";
  if (node instanceof z.ZodNumber) return "number";
  if (node instanceof z.ZodBoolean) return "boolean";
  if (node instanceof z.ZodBigInt) return "number";
  if (node instanceof z.ZodLiteral) {
    const value = (node as unknown as { _def: { value: unknown } })._def.value;
    if (typeof value === "string") return `"${escapeLuauString(value)}"`;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "any";
  }
  if (node instanceof z.ZodEnum) {
    const enumNode = node as unknown as {
      options?: readonly string[];
      _def?: { values?: readonly string[]; entries?: Record<string, string> };
    };
    const values =
      enumNode.options ??
      enumNode._def?.values ??
      (enumNode._def?.entries ? Object.values(enumNode._def.entries) : []);
    if (!values.length) return "string";
    return values.map((v) => `"${escapeLuauString(v)}"`).join(" | ");
  }
  if (node instanceof z.ZodArray) {
    const arr = node as unknown as { element?: z.ZodTypeAny; _def?: { type?: z.ZodTypeAny; element?: z.ZodTypeAny } };
    const elem = arr.element ?? arr._def?.element ?? arr._def?.type;
    return elem ? `{${inner(elem)}}` : "{any}";
  }
  if (node instanceof z.ZodObject) {
    const shape = (node as z.ZodObject<z.ZodRawShape>).shape as Record<string, unknown>;
    const entries = Object.entries(shape);
    if (!entries.length) return "{}";
    const parts = entries.map(([key, value]) => {
      const t = inner(value as z.ZodTypeAny);
      return `${key}: ${t}`;
    });
    return `{ ${parts.join(", ")} }`;
  }
  if (node instanceof z.ZodUnion) {
    const options = (node as unknown as { _def: { options: readonly z.ZodTypeAny[] } })._def.options;
    return options.map((o) => inner(o)).join(" | ");
  }
  if (node instanceof z.ZodRecord) {
    const def = (node as unknown as { _def: { valueType?: z.ZodTypeAny } })._def;
    const v = def.valueType ? inner(def.valueType) : "any";
    return `{[string]: ${v}}`;
  }
  if (node instanceof z.ZodNull) return "nil";
  // Catch-all
  return "any";
}
