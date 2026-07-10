import { z } from "zod";
import {
  buildAssertionLuau,
  normalizeAssertionReport,
  type LiveAssertion,
} from "../../application/services/assertion-engine.js";
import { defineTool } from "../../application/tool/define-tool.js";

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .describe("Stable assertion ID used to identify this result.");
const pathSchema = z
  .string()
  .min(1)
  .max(500)
  .describe("Dotted live Instance path beginning at game, workspace, or a service name.");
const memberSchema = z.string().min(1).max(128);
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

const selectorSchema = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("class"),
    value: z
      .string()
      .min(1)
      .max(128)
      .describe("Roblox class name accepted by Instance:IsA, such as BasePart."),
  }),
  z.object({
    by: z.literal("name"),
    value: z.string().min(1).max(256),
    match: z.enum(["equals", "contains"]).optional().default("equals"),
    caseSensitive: z.boolean().optional().default(false),
  }),
  z.object({
    by: z.literal("text"),
    value: z.string().min(1).max(1000),
    match: z.enum(["equals", "contains"]).optional().default("contains"),
    caseSensitive: z.boolean().optional().default(false),
  }),
]);

export const liveAssertionSchema = z.discriminatedUnion("kind", [
  z.object({ id: idSchema, kind: z.literal("path-exists"), path: pathSchema }),
  z.object({ id: idSchema, kind: z.literal("path-not-exists"), path: pathSchema }),
  z.object({
    id: idSchema,
    kind: z.literal("property-equals"),
    path: pathSchema,
    property: memberSchema,
    expected: scalarSchema,
  }),
  z.object({
    id: idSchema,
    kind: z.literal("property-not-equals"),
    path: pathSchema,
    property: memberSchema,
    expected: scalarSchema,
  }),
  z.object({
    id: idSchema,
    kind: z.literal("property-contains"),
    path: pathSchema,
    property: memberSchema,
    expected: z.string().max(2000),
    caseSensitive: z.boolean().optional().default(false),
  }),
  z.object({
    id: idSchema,
    kind: z.literal("property-greater"),
    path: pathSchema,
    property: memberSchema,
    expected: z.number().finite(),
  }),
  z.object({
    id: idSchema,
    kind: z.literal("property-less"),
    path: pathSchema,
    property: memberSchema,
    expected: z.number().finite(),
  }),
  z.object({
    id: idSchema,
    kind: z.literal("attribute-equals"),
    path: pathSchema,
    attribute: memberSchema,
    expected: scalarSchema,
  }),
  z.object({
    id: idSchema,
    kind: z.literal("gui-visible"),
    path: pathSchema,
    expected: z.boolean().optional().default(true),
    effective: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include hidden GuiObject ancestors and disabled LayerCollectors."),
  }),
  z.object({
    id: idSchema,
    kind: z.literal("gui-enabled"),
    path: pathSchema,
    expected: z.boolean().optional().default(true),
  }),
  z.object({
    id: idSchema,
    kind: z.literal("descendant-exists"),
    path: pathSchema,
    selector: selectorSchema,
    expected: z.boolean().optional().default(true),
  }),
  z.object({
    id: idSchema,
    kind: z.literal("character-distance"),
    targetPath: pathSchema,
    operator: z.enum(["at-most", "at-least"]),
    distance: z.number().finite().nonnegative().max(1_000_000),
    playerName: z.string().min(1).max(64).optional(),
    characterPath: pathSchema.optional(),
    rootPath: pathSchema.optional(),
  }),
  z.object({
    id: idSchema,
    kind: z.literal("camera-facing"),
    targetPath: pathSchema,
    maxAngleDegrees: z.number().finite().min(0).max(180).optional().default(10),
    cameraPath: pathSchema.optional(),
  }),
  z.object({
    id: idSchema,
    kind: z.literal("collection-count"),
    path: pathSchema,
    scope: z.enum(["children", "descendants"]).optional().default("children"),
    operator: z.enum(["equals", "not-equals", "greater", "less", "at-least", "at-most"]),
    count: z.number().int().nonnegative().max(1_000_000),
    selector: selectorSchema.optional(),
  }),
]);

const inputSchema = z
  .object({
    assertions: z
      .array(liveAssertionSchema)
      .min(1)
      .max(50)
      .describe("Predicates evaluated together against one live-game snapshot."),
    scanLimit: z
      .number()
      .int()
      .positive()
      .max(5000)
      .optional()
      .default(1500)
      .describe("Maximum descendants examined by any bounded search."),
    readBudget: z
      .number()
      .int()
      .positive()
      .max(50000)
      .optional()
      .default(15000)
      .describe("Maximum guarded live reads shared by the whole assertion batch."),
    timeoutMs: z.number().int().min(1000).max(30000).optional().default(20000),
    threadContext: z.number().int().optional(),
  })
  .superRefine(({ assertions }, refinement) => {
    const seen = new Set<string>();
    for (const assertion of assertions) {
      if (seen.has(assertion.id)) {
        refinement.addIssue({
          code: "custom",
          path: ["assertions"],
          message: `Assertion ID '${assertion.id}' is duplicated.`,
        });
      }
      seen.add(assertion.id);
    }
  });

export default defineTool({
  name: "assert-state",
  title: "Assert live game state",
  description:
    "VERIFY LIVE OUTCOMES in one bounded, read-only execution. Evaluate path existence, property and attribute values, " +
    "effective GUI state, bounded descendant searches, custom-character distance, camera facing angle, and collection " +
    "counts. Every result includes expected/actual evidence and errors. Missing, unreadable, or incomplete state always " +
    "fails instead of being mistaken for success. Use this after actions and consume aggregate.passed, passRatio, and " +
    "confidence as proof of the real outcome.",
  category: "Intelligence",
  mutatesState: false,
  ai: {
    phase: "verify",
    prerequisites: ["active-client"],
    consumes: ["assertion predicates", "live instance paths"],
    produces: ["per-assertion evidence", "aggregate verification result"],
    verifiesWith: [],
    alternatives: ["verify-path-exists", "get-instance-properties", "script"],
    requiresCapabilities: [],
    sideEffects: [],
    failureRecovery: [
      "inspect result errors and evidence",
      "rediscover stale paths before retrying",
      "provide rootPath or characterPath for game-specific avatars",
    ],
  },
  input: inputSchema,
  async execute({ assertions, scanLimit, readBudget, timeoutMs, threadContext }, ctx) {
    const liveAssertions: readonly LiveAssertion[] = assertions;
    const source = buildAssertionLuau(liveAssertions, { scanLimit, readBudget });
    const raw = await ctx.runLuau(source, {
      timeoutMs,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    const report = normalizeAssertionReport(raw, liveAssertions);
    return {
      data: report,
      summary: `${report.aggregate.passedCount}/${report.aggregate.total} live assertion(s) passed; confidence ${report.confidence.toFixed(2)}.`,
      isError: report.results.some((result) => result.errors.length > 0),
    };
  },
});
