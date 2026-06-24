import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  describeInputFields,
  inputSignature,
} from "../../src/application/services/schema-introspect.js";

describe("schema-introspect", () => {
  it("walks a flat ZodObject and reports name/type/optional/description per field", () => {
    const schema = z.object({
      name: z.string().describe("Player username."),
      score: z.number().int().optional().describe("Optional score override."),
      bool: z.boolean(),
    });
    const fields = describeInputFields(schema);
    expect(fields).toEqual([
      { name: "name", type: "string", optional: false, description: "Player username." },
      { name: "score", type: "number?", optional: true, description: "Optional score override." },
      { name: "bool", type: "boolean", optional: false, description: null },
    ]);
  });

  it("picks up the description on an Optional/Default wrapper through unwrap", () => {
    const schema = z.object({
      limit: z.number().optional().describe("Outer description"),
    });
    const fields = describeInputFields(schema);
    expect(fields[0]?.description).toBe("Outer description");
  });

  it("inputSignature emits a one-line Luau-style signature", () => {
    const schema = z.object({
      a: z.string(),
      b: z.number().optional(),
    });
    expect(inputSignature(schema)).toBe("{ a: string, b: number? }");
  });

  it("inputSignature emits `{}` for an empty object schema", () => {
    expect(inputSignature(z.object({}))).toBe("{}");
  });

  it("describeInputFields returns [] for non-object schemas", () => {
    expect(describeInputFields(z.string())).toEqual([]);
  });
});
