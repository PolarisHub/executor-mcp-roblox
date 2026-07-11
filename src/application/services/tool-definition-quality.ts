import type { z } from "zod";

import type { Tool, ToolContract, ToolDefinitionQuality, ToolResult } from "../tool/tool.js";
import { inferToolContract } from "../tool/tool-contract.js";
import { describeInputFields, inputSignature, type InputField } from "./schema-introspect.js";

export interface QualityToolLike {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly mutatesState?: boolean;
  readonly requiresClient?: boolean;
  readonly ai?: ToolContract;
  readonly quality?: ToolDefinitionQuality;
  readonly input: z.ZodTypeAny;
}

export interface ToolUsageGuidance {
  readonly signature: string;
  readonly requiredInputs: readonly string[];
  readonly optionalInputs: readonly string[];
  readonly fields: readonly InputField[];
  readonly exampleInput: Readonly<Record<string, unknown>>;
  readonly example: string;
  readonly callWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly safety: {
    readonly readOnly: boolean;
    readonly mutatesState: boolean;
    readonly requiresClient: boolean;
    readonly sideEffects: readonly string[];
  };
  readonly execution: {
    readonly phase: ToolContract["phase"];
    readonly estimatedCost: "low" | "medium" | "high";
    readonly idempotency: "read-only" | "idempotent-write" | "contextual-write";
    readonly prerequisites: readonly string[];
    readonly capabilities: readonly string[];
  };
  readonly success: {
    readonly produces: readonly string[];
    readonly verifiesWith: readonly string[];
  };
  readonly alternatives: readonly string[];
  readonly recovery: readonly string[];
  readonly quality: ToolDefinitionQuality;
}

function effectiveContract(tool: QualityToolLike): ToolContract {
  return (
    tool.ai ??
    inferToolContract({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      category: tool.category,
      input: tool.input,
      requiresClient: tool.requiresClient,
      mutatesState: tool.mutatesState,
    })
  );
}

function grade(score: number): ToolDefinitionQuality["grade"] {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function assessToolDefinition(tool: QualityToolLike): ToolDefinitionQuality {
  const fields = describeInputFields(tool.input);
  const contract = effectiveContract(tool);
  const explicit = fields.filter((field) => field.descriptionSource === "explicit").length;
  const inferred = fields.length - explicit;
  const issues: string[] = [];
  const strengths: string[] = [];
  let score = 100;

  const descriptionLength = tool.description.replace(/\s+/g, " ").trim().length;
  if (descriptionLength < 40) {
    score -= 20;
    issues.push("base description is too short to explain behavior and boundaries");
  } else if (descriptionLength < 120) {
    score -= 6;
    issues.push(
      "base description is concise; compiled guidance supplies missing operational detail",
    );
  } else {
    strengths.push("detailed base description");
  }
  if (!tool.title.trim() || tool.title === tool.name) {
    score -= 12;
    issues.push("title does not add human-readable intent beyond the tool name");
  } else {
    strengths.push("human-readable title");
  }
  if (inferred > 0) {
    score -= Math.min(8, Math.ceil(inferred / 5));
    issues.push(`${inferred} input field description(s) are centrally inferred`);
  } else if (fields.length > 0) {
    strengths.push("all input fields explicitly documented");
  }
  if (contract.consumes.length === 0 || contract.produces.length === 0) {
    score -= 15;
    issues.push("AI data-flow contract is incomplete");
  } else {
    strengths.push("complete AI data-flow contract");
  }
  if (contract.failureRecovery.length === 0) {
    score -= 15;
    issues.push("no failure recovery guidance");
  } else {
    strengths.push("structured recovery guidance");
  }
  if (tool.requiresClient !== false && !contract.prerequisites.includes("active-client")) {
    score -= 18;
    issues.push("client-bound tool does not declare active-client prerequisite");
  }
  if (tool.mutatesState && contract.sideEffects.length === 0) {
    score -= 20;
    issues.push("mutating tool does not declare side effects");
  }
  if (tool.mutatesState && contract.verifiesWith.length === 0) {
    score -= 12;
    issues.push("mutating tool has no verification recommendation");
  }
  if (tool.mutatesState && contract.sideEffects.length > 0 && contract.verifiesWith.length > 0) {
    strengths.push("mutation, side-effect, and verification metadata aligned");
  }

  score = Math.max(0, Math.min(100, score));
  return {
    score,
    grade: grade(score),
    explicitFieldDescriptions: explicit,
    inferredFieldDescriptions: inferred,
    issues,
    strengths,
  };
}

function luauLiteral(value: unknown, depth = 0): string {
  if (depth > 6) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `{ ${value
      .slice(0, 20)
      .map((entry) => luauLiteral(entry, depth + 1))
      .join(", ")} }`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 30)
      .map(([key, entry]) => {
        const renderedKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `[${JSON.stringify(key)}]`;
        return `${renderedKey} = ${luauLiteral(entry, depth + 1)}`;
      });
    return `{ ${entries.join(", ")} }`;
  }
  return "nil";
}

function schemaAccepts(schema: z.ZodTypeAny, value: unknown): boolean {
  try {
    return schema.safeParse(value).success;
  } catch {
    return false;
  }
}

export function buildToolExampleInput(
  schema: z.ZodTypeAny,
  fields: readonly InputField[],
): Readonly<Record<string, unknown>> {
  const required = Object.fromEntries(
    fields.filter((field) => !field.optional).map((field) => [field.name, field.example]),
  );
  if (schemaAccepts(schema, required)) return required;

  const optional = fields.filter((field) => field.optional);
  for (const field of optional) {
    const candidate = { ...required, [field.name]: field.example };
    if (schemaAccepts(schema, candidate)) return candidate;
  }
  const expanded = { ...required };
  for (const field of optional) {
    expanded[field.name] = field.example;
    if (schemaAccepts(schema, expanded)) return expanded;
  }
  return required;
}

export function buildToolExample(
  name: string,
  schema: z.ZodTypeAny,
  fields: readonly InputField[],
): string {
  const camel = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const input = buildToolExampleInput(schema, fields);
  if (Object.keys(input).length === 0) return `mcp.${camel}()`;
  const args = Object.entries(input)
    .map(([key, value]) => `${key} = ${luauLiteral(value)}`)
    .join(", ");
  return `mcp.${camel}({ ${args} })`;
}

function estimatedCost(tool: QualityToolLike): "low" | "medium" | "high" {
  const name = tool.name.toLowerCase();
  if (/fanout|getgc|scan|decompile|disassemble|tree|loop|profile|memory|bytecode/.test(name)) {
    return "high";
  }
  if (tool.requiresClient !== false || describeInputFields(tool.input).length >= 5) return "medium";
  return "low";
}

function idempotency(tool: QualityToolLike): ToolUsageGuidance["execution"]["idempotency"] {
  if (!tool.mutatesState) return "read-only";
  if (/^set-|replace|clear-|block-|ignore-|select-client/.test(tool.name))
    return "idempotent-write";
  return "contextual-write";
}

export function buildToolGuidance(tool: QualityToolLike): ToolUsageGuidance {
  const fields = describeInputFields(tool.input);
  const contract = effectiveContract(tool);
  const exampleInput = buildToolExampleInput(tool.input, fields);
  const requiredInputs = fields.filter((field) => !field.optional).map((field) => field.name);
  const optionalInputs = fields.filter((field) => field.optional).map((field) => field.name);
  const requiresClient = tool.requiresClient !== false;
  const mutatesState = tool.mutatesState === true;
  const avoidWhen = [
    ...(requiresClient ? ["No active client is selected or the bridge is disconnected."] : []),
    ...(contract.requiresCapabilities.length > 0
      ? ["A required executor capability is absent; use a listed alternative."]
      : []),
    ...(mutatesState
      ? ["The target, arguments, approval, or postcondition is still ambiguous."]
      : []),
  ];
  return {
    signature: inputSignature(tool.input),
    requiredInputs,
    optionalInputs,
    fields,
    exampleInput,
    example: buildToolExample(tool.name, tool.input, fields),
    callWhen: [
      `The goal matches: ${tool.title.replace(/[.]+$/, "").toLowerCase()}.`,
      `The ${contract.phase} phase needs ${contract.produces.join(" or ")}.`,
    ],
    avoidWhen,
    safety: {
      readOnly: !mutatesState,
      mutatesState,
      requiresClient,
      sideEffects: contract.sideEffects,
    },
    execution: {
      phase: contract.phase,
      estimatedCost: estimatedCost(tool),
      idempotency: idempotency(tool),
      prerequisites: contract.prerequisites,
      capabilities: contract.requiresCapabilities,
    },
    success: {
      produces: contract.produces,
      verifiesWith: contract.verifiesWith,
    },
    alternatives: contract.alternatives,
    recovery: contract.failureRecovery,
    quality: tool.quality ?? assessToolDefinition(tool),
  };
}

export function formatToolDescription(tool: QualityToolLike): string {
  const guidance = buildToolGuidance(tool);
  const parts = [
    tool.description.replace(/\s+/g, " ").trim(),
    `Signature: ${guidance.signature}.`,
    `Phase: ${guidance.execution.phase}; cost=${guidance.execution.estimatedCost}; idempotency=${guidance.execution.idempotency}.`,
    `Requires: ${guidance.execution.prerequisites.length ? guidance.execution.prerequisites.join(", ") : "none"}.`,
    ...(guidance.execution.capabilities.length
      ? [`Capabilities: ${guidance.execution.capabilities.join(", ")}.`]
      : []),
    `Produces: ${guidance.success.produces.join(", ")}.`,
    ...(guidance.success.verifiesWith.length
      ? [`Verify with: ${guidance.success.verifiesWith.join(", ")}.`]
      : []),
    guidance.safety.mutatesState
      ? `Safety: MUTATING; ${guidance.safety.sideEffects.join(", ") || "writes state"}.`
      : "Safety: read-only.",
    `On failure: ${guidance.recovery[0] ?? "inspect structured recovery and do not retry blindly"}.`,
  ];
  return parts.join(" ").slice(0, 7000);
}

function resultCount(data: unknown): number | undefined {
  if (Array.isArray(data)) return data.length;
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ["count", "total", "matched", "scanned", "availableCount"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  for (const key of ["results", "items", "tools", "clients", "events", "findings"]) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

/** Supply a compact summary for legacy tools without changing their structured data shape. */
export function defaultToolSummary(tool: Pick<Tool, "title">, result: ToolResult): string {
  if (result.summary) return result.summary;
  const count = resultCount(result.data);
  if (result.isError) return `${tool.title} returned a handled error with structured recovery.`;
  return `${tool.title} completed${count !== undefined ? ` with ${count} result(s)` : ""}.`;
}
