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
  /** True when the key may be omitted because it is `.optional()` or has a `.default()`. */
  readonly optional: boolean;
  /** True when the field explicitly accepts `nil`/JSON null. */
  readonly nullable: boolean;
  /** Explicit `.describe()` text or a deterministic field-name/type fallback. */
  readonly description: string;
  /** Whether the author supplied the description or the library inferred it. */
  readonly descriptionSource: "explicit" | "inferred";
  /** Schema default when it is safely serializable. */
  readonly defaultValue?: unknown;
  /** Human-readable numeric/string/enum constraints discovered from the schema. */
  readonly constraints: readonly string[];
  /** Deterministic example value used by tool help and validation recovery. */
  readonly example: unknown;
}

interface UnwrappedSchema {
  readonly inner: z.ZodTypeAny;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly defaultValue?: unknown;
}

function serializableDefault(value: unknown): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value) && value.length <= 20) {
    try {
      JSON.stringify(value);
      return value;
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === "object") {
    try {
      const encoded = JSON.stringify(value);
      if (encoded.length <= 500) return value;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function unwrap(node: z.ZodTypeAny): UnwrappedSchema {
  let inner = node;
  let optional = false;
  let nullable = false;
  let defaultValue: unknown = undefined;
  for (let depth = 0; depth < 12; depth++) {
    if (inner instanceof z.ZodOptional) {
      optional = true;
      inner = inner.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (inner instanceof z.ZodDefault) {
      optional = true;
      const definition = (
        inner as unknown as {
          _def: { innerType: z.ZodTypeAny; defaultValue?: unknown };
        }
      )._def;
      try {
        const candidate = definition.defaultValue;
        defaultValue = serializableDefault(
          typeof candidate === "function" ? (candidate as () => unknown)() : candidate,
        );
      } catch {
        defaultValue = undefined;
      }
      inner = definition.innerType;
      continue;
    }
    if (inner instanceof z.ZodNullable) {
      nullable = true;
      inner = (inner as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
      continue;
    }
    break;
  }
  return {
    inner,
    optional,
    nullable,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}

function pickDescription(node: z.ZodTypeAny): string | null {
  // Zod v4 stores .describe(s) as { description: s } on the schema's metadata,
  // exposed as `node.description` (getter) and also via `node.meta()`. v3 used
  // `_def.description`. Cover both so a future downgrade doesn't break this.
  const v4Direct = (node as unknown as { description?: unknown }).description;
  if (typeof v4Direct === "string" && v4Direct.length > 0) return v4Direct;
  const v4Meta = (
    node as unknown as { meta?: () => { description?: unknown } | undefined }
  ).meta?.();
  const fromMeta = v4Meta?.description;
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  const v3Def = (node as unknown as { _def?: { description?: unknown } })._def;
  const v3 = v3Def?.description;
  if (typeof v3 === "string" && v3.length > 0) return v3;
  const { inner } = unwrap(node);
  if (inner === node) return null;
  return pickDescription(inner);
}

function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function inferDescription(name: string, type: string, optional: boolean): string {
  const lower = name.toLowerCase();
  const prefix = optional ? "Optional " : "";
  if (lower === "threadcontext") {
    return "Optional Roblox thread identity for this call; omit it to use the server default.";
  }
  if (lower === "timeoutms") {
    return "Optional per-call deadline in milliseconds; omit it to use the tool or server default.";
  }
  if (lower === "confirm") {
    return "Explicit safety acknowledgement; must be true before this state-changing operation runs.";
  }
  if (lower === "clientid") return `${prefix}connected Roblox client id returned by list-clients.`;
  if (lower === "username") return `${prefix}Roblox username used to resolve a connected client.`;
  if (lower.includes("functionpath") || lower === "functionexpression") {
    return `${prefix}Luau expression resolving to the target function without invoking it.`;
  }
  if (lower.includes("scriptpath") || lower.includes("modulepath")) {
    return `${prefix}Luau expression or dotted path resolving to the target script/module.`;
  }
  if (lower.includes("instancepath") || lower === "path" || lower.endsWith("path")) {
    return `${prefix}dotted Roblox instance/value path resolved in the active client.`;
  }
  if (lower === "source" || lower.endsWith("source") || lower === "code") {
    return `${prefix}Luau source text processed by this tool; it is never inferred or guessed.`;
  }
  if (lower === "arguments" || lower === "args") {
    return `${prefix}ordered typed arguments forwarded to the selected operation.`;
  }
  if (lower === "query" || lower.endsWith("query") || lower === "search" || lower === "keyword") {
    return `${prefix}search text used to filter and rank bounded results.`;
  }
  if (lower === "limit" || lower.startsWith("max") || lower.endsWith("limit")) {
    return `${prefix}hard result/work budget used to keep output and runtime bounded.`;
  }
  if (lower === "action" || lower === "operation") {
    return `${prefix}operation selector; use one of the schema's allowed values.`;
  }
  if (lower === "value" || lower.endsWith("value")) {
    return `${prefix}typed value consumed by this operation.`;
  }
  if (lower === "state" || lower.endsWith("state")) {
    return `${prefix}state selector or reusable state reference returned by a discovery tool.`;
  }
  if (lower.startsWith("include"))
    return `Whether to include ${humanize(name.slice(7))} in the bounded result.`;
  if (type.includes("boolean")) return `Whether to enable ${humanize(name)}.`;
  if (type.includes("number")) return `${prefix}numeric value for ${humanize(name)}.`;
  if (type.includes("string")) return `${prefix}text value for ${humanize(name)}.`;
  return `${prefix}validated input for ${humanize(name)}.`;
}

interface CheckDefinition {
  readonly check?: string;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly value?: unknown;
  readonly inclusive?: unknown;
  readonly format?: unknown;
  readonly pattern?: unknown;
}

function checkDefinitions(schema: z.ZodTypeAny): readonly CheckDefinition[] {
  const checks = (schema as unknown as { _def?: { checks?: unknown } })._def?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check) => {
    if (!check || typeof check !== "object") return [];
    const record = check as {
      _zod?: { def?: CheckDefinition };
      def?: CheckDefinition;
      _def?: CheckDefinition;
    };
    const definition = record._zod?.def ?? record.def ?? record._def;
    return definition ? [definition] : [];
  });
}

function constraintsOf(inner: z.ZodTypeAny): string[] {
  const schema = inner as unknown as {
    minValue?: unknown;
    maxValue?: unknown;
    minLength?: unknown;
    maxLength?: unknown;
    isInt?: unknown;
    options?: unknown;
    values?: unknown;
  };
  const constraints: string[] = [];
  const checks = checkDefinitions(inner);
  if (schema.isInt === true) constraints.push("integer");

  let hasMinimum = false;
  let hasMaximum = false;
  for (const check of checks) {
    if (check.check === "greater_than" && typeof check.value === "number") {
      constraints.push(
        check.inclusive === false ? `greater than ${check.value}` : `minimum ${check.value}`,
      );
      hasMinimum = true;
    } else if (check.check === "less_than" && typeof check.value === "number") {
      constraints.push(
        check.inclusive === false ? `less than ${check.value}` : `maximum ${check.value}`,
      );
      hasMaximum = true;
    } else if (check.check === "min_length" && typeof check.minimum === "number") {
      constraints.push(`minimum length ${check.minimum}`);
    } else if (check.check === "max_length" && typeof check.maximum === "number") {
      constraints.push(`maximum length ${check.maximum}`);
    } else if (check.check === "string_format" && typeof check.format === "string") {
      if (check.format === "regex" && check.pattern instanceof RegExp) {
        constraints.push(`must match ${String(check.pattern).slice(0, 160)}`);
      } else {
        constraints.push(`format ${check.format}`);
      }
    }
  }

  if (
    !hasMinimum &&
    typeof schema.minValue === "number" &&
    Number.isFinite(schema.minValue) &&
    !(schema.isInt === true && schema.minValue === Number.MIN_SAFE_INTEGER)
  ) {
    constraints.push(`minimum ${schema.minValue}`);
  }
  if (
    !hasMaximum &&
    typeof schema.maxValue === "number" &&
    Number.isFinite(schema.maxValue) &&
    !(schema.isInt === true && schema.maxValue === Number.MAX_SAFE_INTEGER)
  ) {
    constraints.push(`maximum ${schema.maxValue}`);
  }
  if (typeof schema.minLength === "number") constraints.push(`minimum length ${schema.minLength}`);
  if (typeof schema.maxLength === "number") constraints.push(`maximum length ${schema.maxLength}`);
  if (inner instanceof z.ZodEnum && Array.isArray(schema.options) && schema.options.length > 0) {
    constraints.push(`one of: ${schema.options.map(String).join(", ")}`);
  }
  if (inner instanceof z.ZodLiteral && schema.values instanceof Set) {
    constraints.push(`literal: ${[...schema.values].map(String).join(", ")}`);
  }
  return [...new Set(constraints)];
}

function accepts(schema: z.ZodTypeAny, value: unknown): boolean {
  try {
    return schema.safeParse(value).success;
  } catch {
    return false;
  }
}

function checkedLength(schema: z.ZodTypeAny, kind: "min_length" | "max_length"): number | null {
  const check = checkDefinitions(schema).find((candidate) => candidate.check === kind);
  const value = kind === "min_length" ? check?.minimum : check?.maximum;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function baseStringExample(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "threadcontext") return "2";
  if (lower.includes("functionpath") || lower === "functionexpression") {
    return "getgenv().handler";
  }
  if (lower.includes("path")) return "game.Workspace.Target";
  if (lower === "source" || lower === "code" || lower.includes("snippet")) return "return true";
  if (lower.includes("query") || lower === "search" || lower === "keyword") return "target";
  if (lower.includes("url")) return "https://example.com";
  if (lower.includes("uuid")) return "00000000-0000-4000-8000-000000000000";
  if (lower.includes("classname")) return "Part";
  if (lower.endsWith("id")) return "example-id";
  return "example";
}

function fitString(value: string, minimum: number | null, maximum: number | null): string {
  let result = value;
  if (minimum !== null && result.length < minimum) result += "x".repeat(minimum - result.length);
  if (maximum !== null && result.length > maximum) result = result.slice(0, maximum);
  return result;
}

function objectExample(schema: z.ZodObject<z.ZodRawShape>, depth: number): unknown {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const base = Object.fromEntries(
    Object.entries(shape)
      .filter(([, field]) => !unwrap(field).optional)
      .map(([name, field]) => [name, exampleForSchema(name, field, depth + 1)]),
  );
  if (accepts(schema, base)) return base;

  const optional = Object.entries(shape).filter(([, field]) => unwrap(field).optional);
  for (const [name, field] of optional) {
    const candidate = { ...base, [name]: exampleForSchema(name, field, depth + 1) };
    if (accepts(schema, candidate)) return candidate;
  }
  const expanded = { ...base };
  for (const [name, field] of optional) {
    expanded[name] = exampleForSchema(name, field, depth + 1);
    if (accepts(schema, expanded)) return expanded;
  }
  return base;
}

function exampleForSchema(name: string, schema: z.ZodTypeAny, depth = 0): unknown {
  const { inner, defaultValue } = unwrap(schema);
  if (defaultValue !== undefined) return defaultValue;
  if (depth > 6) return null;

  if (inner instanceof z.ZodEnum) return inner.options[0] ?? "example";
  if (inner instanceof z.ZodLiteral) {
    const values = (inner as unknown as { values?: Set<unknown> }).values;
    return values instanceof Set ? ([...values][0] ?? null) : null;
  }
  if (inner instanceof z.ZodUnion) {
    for (const option of inner.options as readonly z.ZodTypeAny[]) {
      const candidate = exampleForSchema(name, option, depth + 1);
      if (accepts(inner, candidate)) return candidate;
    }
    return null;
  }
  if (inner instanceof z.ZodObject) return objectExample(inner, depth);
  if (inner instanceof z.ZodArray) {
    const minimum = checkedLength(inner, "min_length") ?? 0;
    const maximum = checkedLength(inner, "max_length");
    const count = maximum === 0 ? 0 : Math.max(1, minimum);
    const element = exampleForSchema(
      name.replace(/s$/i, ""),
      inner.element as unknown as z.ZodTypeAny,
      depth + 1,
    );
    const populated = Array.from({ length: count }, () => element);
    if (accepts(inner, populated)) return populated;
    if (accepts(inner, [])) return [];
    return populated;
  }
  if (inner instanceof z.ZodRecord) return {};
  if (inner instanceof z.ZodBoolean) return name.toLowerCase() === "confirm";
  if (inner instanceof z.ZodNumber) {
    const numeric = inner as unknown as { minValue?: unknown; maxValue?: unknown; isInt?: unknown };
    const candidates: number[] = [];
    if (name.toLowerCase() === "threadcontext") candidates.push(2);
    if (name.toLowerCase() === "timeoutms") candidates.push(20000);
    if (name.toLowerCase() === "limit" || name.toLowerCase().startsWith("max")) {
      candidates.push(10);
    }
    if (
      typeof numeric.minValue === "number" &&
      Number.isFinite(numeric.minValue) &&
      !(numeric.isInt === true && numeric.minValue === Number.MIN_SAFE_INTEGER)
    ) {
      candidates.push(numeric.minValue, numeric.minValue + (numeric.isInt === true ? 1 : 0.1));
    }
    if (
      typeof numeric.maxValue === "number" &&
      Number.isFinite(numeric.maxValue) &&
      !(numeric.isInt === true && numeric.maxValue === Number.MAX_SAFE_INTEGER)
    ) {
      candidates.push(numeric.maxValue, numeric.maxValue - (numeric.isInt === true ? 1 : 0.1));
    }
    candidates.push(0, 1, -1);
    return candidates.find((candidate) => accepts(inner, candidate)) ?? 0;
  }
  if (inner instanceof z.ZodString) {
    const minimum =
      typeof inner.minLength === "number" ? inner.minLength : checkedLength(inner, "min_length");
    const maximum =
      typeof inner.maxLength === "number" ? inner.maxLength : checkedLength(inner, "max_length");
    const preferred = fitString(baseStringExample(name), minimum, maximum);
    const candidates = [
      preferred,
      fitString("example", minimum, maximum),
      fitString("EXAMPLE", minimum, maximum),
      fitString("target", minimum, maximum),
      fitString("00000000-0000-4000-8000-000000000000", minimum, maximum),
      fitString("https://example.com", minimum, maximum),
    ];
    return candidates.find((candidate) => accepts(inner, candidate)) ?? preferred;
  }
  if (inner instanceof z.ZodUnknown || inner instanceof z.ZodAny) return null;

  const type = (() => {
    try {
      return zodToLuauType(inner);
    } catch {
      return "any";
    }
  })();
  if (type.includes("boolean")) return false;
  if (type.includes("number")) return 0;
  if (type.includes("string")) return baseStringExample(name);
  if (type.startsWith("{")) return {};
  return null;
}

export function describeInputFields(schema: z.ZodTypeAny): readonly InputField[] {
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodTypeAny>;
  const fields: InputField[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const { inner, optional, nullable, defaultValue } = unwrap(value);
    let type: string;
    try {
      type = zodToLuauType(value);
    } catch {
      type = "any";
    }
    const explicitDescription = pickDescription(value);
    fields.push({
      name: key,
      type,
      optional,
      nullable,
      description: explicitDescription ?? inferDescription(key, type, optional),
      descriptionSource: explicitDescription ? "explicit" : "inferred",
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      constraints: constraintsOf(inner),
      example: exampleForSchema(key, value),
    });
  }
  return fields;
}

/**
 * Return the original object shape with effective descriptions attached to the
 * outermost field schemas. Zod metadata is immutable, so this does not mutate
 * the validation schema used by the tool. MCP clients therefore see the same
 * inferred help that `tool-schema`, generated Luau types, and validation errors
 * expose, while all defaults/refinements/optional wrappers remain intact.
 */
export function documentedInputShape(schema: z.ZodTypeAny): z.ZodRawShape {
  if (!(schema instanceof z.ZodObject)) return {};
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodTypeAny>;
  const descriptions = new Map(describeInputFields(schema).map((field) => [field.name, field]));
  return Object.fromEntries(
    Object.entries(shape).map(([name, fieldSchema]) => {
      const field = descriptions.get(name);
      return [name, field ? fieldSchema.describe(field.description) : fieldSchema];
    }),
  );
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
