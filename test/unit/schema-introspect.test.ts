import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  describeInputFields,
  documentedInputShape,
  inputSignature,
} from "../../src/application/services/schema-introspect.js";

describe("schema-introspect", () => {
  it("walks a flat ZodObject and reports complete field guidance", () => {
    const schema = z.object({
      name: z.string().describe("Player username."),
      score: z.number().int().optional().describe("Optional score override."),
      bool: z.boolean(),
    });
    const fields = describeInputFields(schema);
    expect(fields).toEqual([
      {
        name: "name",
        type: "string",
        optional: false,
        nullable: false,
        description: "Player username.",
        descriptionSource: "explicit",
        constraints: [],
        example: "example",
      },
      {
        name: "score",
        type: "number?",
        optional: true,
        nullable: false,
        description: "Optional score override.",
        descriptionSource: "explicit",
        constraints: ["integer"],
        example: 0,
      },
      {
        name: "bool",
        type: "boolean",
        optional: false,
        nullable: false,
        description: "Whether to enable bool.",
        descriptionSource: "inferred",
        constraints: [],
        example: false,
      },
    ]);
  });

  it("picks up the description on an Optional/Default wrapper through unwrap", () => {
    const schema = z.object({
      limit: z.number().optional().describe("Outer description"),
    });
    const fields = describeInputFields(schema);
    expect(fields[0]?.description).toBe("Outer description");
  });

  it("distinguishes an omittable key from a required nullable value", () => {
    const fields = describeInputFields(
      z.object({ requiredNullable: z.string().nullable(), optional: z.string().optional() }),
    );

    expect(fields[0]).toMatchObject({ optional: false, nullable: true });
    expect(fields[1]).toMatchObject({ optional: true, nullable: false });
  });

  it("extracts defaults, useful constraints, and deterministic examples", () => {
    const schema = z.object({
      limit: z.number().int().min(1).max(25).default(10),
      action: z.enum(["inspect", "apply"]),
      scriptPath: z.string().min(2).max(100),
      confirm: z.boolean(),
    });

    const fields = describeInputFields(schema);
    expect(fields[0]).toMatchObject({
      name: "limit",
      optional: true,
      defaultValue: 10,
      constraints: ["integer", "minimum 1", "maximum 25"],
      example: 10,
      descriptionSource: "inferred",
    });
    expect(fields[1]).toMatchObject({
      constraints: ["one of: inspect, apply"],
      example: "inspect",
    });
    expect(fields[2]).toMatchObject({
      description: "Luau expression or dotted path resolving to the target script/module.",
      constraints: ["minimum length 2", "maximum length 100"],
      example: "game.Workspace.Target",
    });
    expect(fields[3]).toMatchObject({
      description: expect.stringContaining("safety acknowledgement"),
      example: true,
    });
  });

  it("generates valid recursive array, union, object, and regex examples", () => {
    const typedValue = z.object({
      type: z.enum(["string", "number"]),
      value: z.union([z.string(), z.number()]),
    });
    const schema = z.object({
      snippets: z.array(z.string()).min(1).max(3),
      clients: z.union([z.array(z.string()).min(1), z.literal("all")]),
      value: typedValue,
      id: z.string().regex(/^[A-Za-z]+$/),
    });
    const fields = describeInputFields(schema);
    const sample = Object.fromEntries(fields.map((field) => [field.name, field.example]));

    expect(fields.find((field) => field.name === "snippets")?.constraints).toEqual([
      "minimum length 1",
      "maximum length 3",
    ]);
    expect(fields.find((field) => field.name === "clients")?.example).not.toHaveProperty("def");
    expect(fields.find((field) => field.name === "id")?.constraints[0]).toContain("must match");
    expect(schema.safeParse(sample).success).toBe(true);
  });

  it("inputSignature emits a one-line Luau-style signature", () => {
    const schema = z.object({
      a: z.string(),
      b: z.number().optional(),
    });
    expect(inputSignature(schema)).toBe("{ a: string, b: number? }");
  });

  it("compiles inferred help onto MCP-facing schemas without losing validation", () => {
    const source = z.object({
      confirm: z.boolean(),
      limit: z.number().int().min(1).default(10).describe("Bounded result count."),
    });
    const shape = documentedInputShape(source);
    const compiled = z.object(shape);
    const compiledFields = describeInputFields(compiled);
    const sourceFields = describeInputFields(source);

    expect(compiledFields.find((field) => field.name === "confirm")).toMatchObject({
      description: expect.stringContaining("safety acknowledgement"),
      descriptionSource: "explicit",
    });
    expect(compiledFields.find((field) => field.name === "limit")?.description).toBe(
      "Bounded result count.",
    );
    expect(compiled.parse({ confirm: true })).toEqual({ confirm: true, limit: 10 });
    expect(() => compiled.parse({ confirm: true, limit: 0 })).toThrow();
    expect(sourceFields.find((field) => field.name === "confirm")?.descriptionSource).toBe(
      "inferred",
    );
  });

  it("inputSignature emits `{}` for an empty object schema", () => {
    expect(inputSignature(z.object({}))).toBe("{}");
  });

  it("describeInputFields returns [] for non-object schemas", () => {
    expect(describeInputFields(z.string())).toEqual([]);
  });
});
