import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

const MUTATING_GUARD = new Set<string>([
  // Tools that obviously mutate game state or external systems. Replaying any
  // of these without explicit operator intent is a foot-gun, so we surface
  // them as "blockedByDefault" so the AI has to ack the risk.
  "execute", "execute-and-wait", "execute-file", "batch-execute", "script",
  "script-fanout", "playbook-run", "fire-remote", "fire-signal",
  "set-instance-property", "set-properties-bulk", "set-attribute",
  "create-instance", "destroy-instance", "clone-instance",
  "write-file", "delete-file", "delete-folder", "make-folder", "append-file",
  "set-fps-cap", "set-fast-flag", "set-clipboard", "select-client",
  "clear-selection", "ws-send", "ws-close", "send-packet", "block-packets",
  "hook-function", "hook-metamethod", "restore-hook", "spoof-function-return",
]);

export default defineTool({
  name: "session-replay",
  title: "Plan or Replay a Recorded Session's Tool Calls",
  description:
    "Read one session's recorded trace and (by default) return a structured plan; pass `dryRun: false` to " +
    "actually re-issue each plannable step through the invoker. Tools that mutate game/host state are flagged " +
    "`blockedByDefault: true` and are SKIPPED unless `includeMutating: true` is also set. Steps that originally " +
    "failed are never replayed. The replayed steps themselves get recorded into the CURRENT session's trace, " +
    "so you can chain saves into a playbook via `playbook-save`. session-replay refuses to call itself.",
  category: "Diagnostics",
  mutatesState: true,
  requiresClient: false,
  input: z.object({
    sessionId: z.string().min(1).describe("Session UUID from session-list."),
    from: z.number().int().positive().optional(),
    to: z.number().int().positive().optional(),
    includeMutating: z
      .boolean()
      .optional()
      .describe("Allow flagged-mutating tools to be planned/executed. Default false."),
    dryRun: z
      .boolean()
      .optional()
      .describe("When true (default) only returns the plan. False actually re-issues each step in order."),
  }),
  async execute({ sessionId, from, to, includeMutating, dryRun }, ctx) {
    const opts: { from?: number; to?: number } = {};
    if (from !== undefined) opts.from = from;
    if (to !== undefined) opts.to = to;
    const records = await ctx.sessionLogger.read(sessionId, opts);

    const skippedErrors = records.filter((r) => r.error).length;
    const planned: {
      seq: number;
      tool: string;
      input: unknown;
      originalElapsedMs: number;
      wouldRun: boolean;
      blockedByDefault?: true;
    }[] = [];
    for (const r of records) {
      if (r.error) continue;
      if (r.tool === "session-replay") continue; // never recurse into self
      const blocked = MUTATING_GUARD.has(r.tool);
      if (blocked && !includeMutating) continue;
      planned.push({
        seq: r.seq,
        tool: r.tool,
        input: r.input,
        originalElapsedMs: r.elapsedMs,
        wouldRun: !blocked,
        ...(blocked ? { blockedByDefault: true as const } : {}),
      });
    }

    if (dryRun !== false) {
      return {
        data: {
          sessionId,
          mode: "plan",
          steps: planned,
          summary: {
            total: records.length,
            plannable: planned.length,
            skippedErrors,
          },
        },
      };
    }

    // Live replay: invoke each step through the invoker and collect outcomes.
    const startedAt = Date.now();
    const results: {
      seq: number;
      tool: string;
      ok: boolean;
      data?: unknown;
      error?: string;
      elapsedMs: number;
    }[] = [];
    let okCount = 0;
    let failed = 0;
    for (const step of planned) {
      const t0 = Date.now();
      try {
        const res = await ctx.invokeTool(step.tool, step.input);
        results.push({
          seq: step.seq,
          tool: step.tool,
          ok: !res.isError,
          data: res.data,
          elapsedMs: Date.now() - t0,
        });
        if (res.isError) failed += 1;
        else okCount += 1;
      } catch (thrown) {
        results.push({
          seq: step.seq,
          tool: step.tool,
          ok: false,
          error: (thrown as Error).message,
          elapsedMs: Date.now() - t0,
        });
        failed += 1;
      }
    }
    return {
      data: {
        sessionId,
        mode: "replay",
        results,
        summary: {
          total: records.length,
          replayed: results.length,
          ok: okCount,
          failed,
          skippedErrors,
          totalMs: Date.now() - startedAt,
        },
      },
    };
  },
});
