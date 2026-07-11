import { describe, expect, it } from "vitest";
import { z } from "zod";

import { documentedInputShape } from "../../src/application/services/schema-introspect.js";
import { zodToJsonSchema } from "../../src/infrastructure/dashboard/zod-json-schema.js";

describe("zodToJsonSchema", () => {
  it("preserves effective help and nested input constraints", () => {
    const source = z.object({
      query: z.string().min(2),
      limit: z.number().int().min(1).max(25).default(10),
      mode: z.enum(["quick", "deep"]).optional(),
      tags: z.array(z.string()).min(1),
      nullableValue: z.string().nullable(),
    });
    const schema = zodToJsonSchema(z.object(documentedInputShape(source)));
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;

    expect(schema["required"]).toEqual(["query", "tags", "nullableValue"]);
    expect(properties["query"]).toMatchObject({
      type: "string",
      minLength: 2,
      description: expect.stringContaining("search text"),
    });
    expect(properties["limit"]).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 25,
      default: 10,
    });
    expect(properties["mode"]?.["enum"]).toEqual(["quick", "deep"]);
    expect(properties["tags"]).toMatchObject({ minItems: 1, type: "array" });
    expect(properties["nullableValue"]?.["anyOf"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "null" })]),
    );
  });
});
