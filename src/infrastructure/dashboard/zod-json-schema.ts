import { z } from "zod";

type Json = Record<string, unknown>;

/**
 * Convert a tool input schema with Zod's native draft-2020-12 converter.
 * Input mode preserves the distinction between required keys, optional keys,
 * and defaults while retaining nested descriptions, formats, ranges, unions,
 * literals, nullable values, array bounds, and record value schemas.
 *
 * Conversion remains fail-closed for dashboard availability: a future custom
 * Zod node may degrade to an empty schema, but it can never crash the endpoint.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Json {
  try {
    return z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
      reused: "inline",
    });
  } catch {
    return {};
  }
}
