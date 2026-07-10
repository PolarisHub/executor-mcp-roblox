import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

const MEMORY_TAG = "agent-memory";

interface MemoryRecord {
  readonly kind: "agent-memory";
  readonly key: string;
  readonly text?: string;
  readonly facts?: Record<string, unknown>;
  readonly scope?: string;
  readonly createdAt: number;
  readonly sourceSession?: string;
}

function memoryName(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56);
  return `memory_${safe || "unnamed"}`;
}

function decode(source: string): MemoryRecord | null {
  try {
    const value = JSON.parse(source) as Partial<MemoryRecord>;
    if (value.kind !== "agent-memory" || typeof value.key !== "string") return null;
    return value as MemoryRecord;
  } catch {
    return null;
  }
}

export default defineTool({
  name: "agent-memory",
  title: "Remember and recall successful agent facts/workflows",
  description:
    "PERSISTENT AGENT MEMORY. Store, recall, or forget compact facts and successful workflow notes across tasks. " +
    "Memory is scoped optionally by game/place/executor and stored in the existing local playbook store, never in " +
    "the Roblox game. Use remember after a verified discovery or successful workflow; use recall before planning a " +
    "similar task. The learn-session operation summarizes the current session's successful tool sequence into a reusable " +
    "episodic memory. Do not store secrets or tokens.",
  category: "Utility",
  requiresClient: false,
  mutatesState: false,
  input: z.object({
    operation: z
      .enum(["remember", "recall", "forget", "learn-session"])
      .describe("Memory operation."),
    key: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("Stable memory key, such as 'shop-button-path'."),
    text: z
      .string()
      .max(10000)
      .optional()
      .describe("Human-readable fact or workflow note to remember."),
    facts: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Structured facts to store alongside the note."),
    scope: z.string().max(200).optional().describe("Optional game/place/executor scope label."),
    query: z
      .string()
      .max(200)
      .optional()
      .describe("Recall filter matched against key, text, facts, and scope."),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .default(10)
      .describe("Maximum memories to return."),
    fromSeq: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("For learn-session, only use trace records from this sequence onward."),
  }),
  async execute({ operation, key, text, facts, scope, query, limit, fromSeq }, ctx) {
    if (operation === "remember") {
      if (!key) return { data: { ok: false, error: "remember requires key" }, isError: true };
      if (!text && !facts)
        return { data: { ok: false, error: "remember requires text or facts" }, isError: true };
      const record: MemoryRecord = {
        kind: "agent-memory",
        key,
        ...(text ? { text } : {}),
        ...(facts ? { facts } : {}),
        ...(scope ? { scope } : {}),
        createdAt: Date.now(),
        sourceSession: ctx.session.id,
      };
      const stored = await ctx.playbooks.save({
        name: memoryName(key),
        source: JSON.stringify(record),
        description: text?.slice(0, 180) ?? `Facts for ${key}`,
        tags: [MEMORY_TAG, ...(scope ? [scope] : [])],
      });
      return { data: { ok: true, key, name: stored.name, scope }, summary: `Remembered "${key}".` };
    }

    if (operation === "forget") {
      if (!key) return { data: { ok: false, error: "forget requires key" }, isError: true };
      const deleted = await ctx.playbooks.delete(memoryName(key));
      return {
        data: { ok: deleted, key, deleted },
        summary: deleted ? `Forgot "${key}".` : `No memory found for "${key}".`,
      };
    }

    if (operation === "learn-session") {
      const records = (await ctx.sessionLogger.read(ctx.session.id, { from: fromSeq })).filter(
        (record) => record.result !== undefined,
      );
      const tools = records.map((record) => record.tool);
      const learnedKey = key ?? `workflow_${Date.now()}`;
      const record: MemoryRecord = {
        kind: "agent-memory",
        key: learnedKey,
        text: text ?? `Successful session workflow: ${tools.join(" → ") || "no successful tools"}`,
        facts: { tools, count: records.length, ...(facts ?? {}) },
        ...(scope ? { scope } : {}),
        createdAt: Date.now(),
        sourceSession: ctx.session.id,
      };
      await ctx.playbooks.save({
        name: memoryName(learnedKey),
        source: JSON.stringify(record),
        description: record.text,
        tags: [MEMORY_TAG, "workflow", ...(scope ? [scope] : [])],
      });
      return {
        data: { ok: true, key: learnedKey, tools, count: records.length },
        summary: `Learned ${records.length}-step session workflow.`,
      };
    }

    const saved = await ctx.playbooks.list({ tag: MEMORY_TAG });
    const term = query?.toLowerCase();
    const memories = saved
      .map((entry) => decode(entry.source))
      .filter((entry): entry is MemoryRecord => entry !== null)
      .filter((entry) => !scope || entry.scope === scope)
      .filter((entry) => {
        if (!term) return true;
        return JSON.stringify(entry).toLowerCase().includes(term);
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    return {
      data: { ok: true, count: memories.length, memories },
      summary: `Recalled ${memories.length} memory item(s).`,
    };
  },
});
