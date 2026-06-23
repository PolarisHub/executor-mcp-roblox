import { z } from "zod";

/**
 * Tiny Zod → JSON Schema converter for the shapes our tools actually use.
 * Returns a JSON-Schema-ish object that downstream clients (REPL autocomplete,
 * IntelliSense d.luau emitter, playbook param forms) can validate against.
 *
 * We don't depend on `zod-to-json-schema` because the surface here is small and
 * stable — tools are almost all `z.object` with primitive or optional fields,
 * occasional enums/literals/arrays. Unhandled shapes degrade to `{}` so a new
 * tool author never gets a crash from this converter.
 */

type Json = Record<string, unknown>;

function describe(node: z.ZodTypeAny): string | undefined {
  // Zod stores .describe(...) on _def.description; access defensively.
  const def = (node as unknown as { _def?: { description?: unknown } })._def;
  const d = def?.description;
  return typeof d === "string" ? d : undefined;
}

function unwrapOptional(node: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean } {
  if (node instanceof z.ZodOptional) {
    return { inner: node.unwrap() as z.ZodTypeAny, optional: true };
  }
  if (node instanceof z.ZodDefault) {
    // ZodDefault wraps an inner type with a default value; treat as optional.
    const inner = (node as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
    return { inner, optional: true };
  }
  if (node instanceof z.ZodNullable) {
    const inner = (node as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
    return { inner, optional: false };
  }
  return { inner: node, optional: false };
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Json {
  try {
    const { inner } = unwrapOptional(schema);
    const description = describe(schema) ?? describe(inner);
    return description ? { ...convertInner(inner), description } : convertInner(inner);
  } catch {
    // Defensive: a zod internal-shape change should never 500 the endpoint.
    return {};
  }
}

function convertInner(node: z.ZodTypeAny): Json {
  if (node instanceof z.ZodString) return { type: "string" };
  if (node instanceof z.ZodNumber) return { type: "number" };
  if (node instanceof z.ZodBoolean) return { type: "boolean" };
  if (node instanceof z.ZodBigInt) return { type: "integer", format: "int64" };
  if (node instanceof z.ZodLiteral) {
    const value = (node as unknown as { _def: { value: unknown } })._def.value;
    return { const: value };
  }
  if (node instanceof z.ZodEnum) {
    // zod v4 exposes the value set on `.options`; v3 had `_def.values`.
    const enumNode = node as unknown as {
      options?: readonly string[];
      _def?: { values?: readonly string[]; entries?: Record<string, string> };
    };
    const values =
      enumNode.options ??
      enumNode._def?.values ??
      (enumNode._def?.entries ? Object.values(enumNode._def.entries) : []);
    return { type: "string", enum: [...values] };
  }
  if (node instanceof z.ZodArray) {
    const arrNode = node as unknown as { element?: z.ZodTypeAny; _def?: { type?: z.ZodTypeAny; element?: z.ZodTypeAny } };
    const element =
      arrNode.element ?? arrNode._def?.element ?? arrNode._def?.type;
    return { type: "array", items: element ? zodToJsonSchema(element) : {} };
  }
  if (node instanceof z.ZodObject) {
    const shape = (node as z.ZodObject<z.ZodRawShape>).shape as Record<string, unknown>;
    const properties: Json = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const { inner, optional } = unwrapOptional(value as z.ZodTypeAny);
      properties[key] = zodToJsonSchema(inner);
      if (!optional) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    };
  }
  if (node instanceof z.ZodUnion) {
    const options = (node as unknown as { _def: { options: readonly z.ZodTypeAny[] } })._def.options;
    return { anyOf: options.map((o) => zodToJsonSchema(o)) };
  }
  if (node instanceof z.ZodRecord) {
    const def = (node as unknown as { _def: { valueType?: z.ZodTypeAny } })._def;
    return {
      type: "object",
      additionalProperties: def.valueType ? zodToJsonSchema(def.valueType) : true,
    };
  }
  if (node instanceof z.ZodAny || node instanceof z.ZodUnknown) return {};
  if (node instanceof z.ZodNull) return { type: "null" };
  // Catch-all — better to return an empty schema than crash on an unfamiliar shape.
  return {};
}
