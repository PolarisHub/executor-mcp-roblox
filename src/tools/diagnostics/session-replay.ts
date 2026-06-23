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
  "set-fps-cap", "set-fast-flag", "set-clipboard", "set-active-client",
  "clear-selection", "ws-send", "ws-close", "send-packet", "block-packets",
  "hook-function", "hook-metamethod", "restore-hook", "spoof-function-return",
]);

export default defineTool({
  name: "session-replay",
  title: "Plan (or Acknowledge) a Replay of a Recorded Session",
  description:
    "Return a structured replay plan for one session's trace. Each step in the plan is `{ seq, tool, input, " +
    "wouldRun, blockedByDefault?, originalElapsedMs }`. Tools that mutate game/host state are flagged as " +
    "`blockedByDefault: true` so you can review before manually re-issuing. `dryRun: true` (default) only " +
    "returns the plan; setting `dryRun: false` does NOT yet re-issue (this tool is plan-only in v1). To " +
    "replay, the AI reads this plan and re-calls each step itself. Pairs with `playbook-save` to bundle a " +
    "trace into a reusable script.",
  category: "Diagnostics",
  mutatesState: false,
  requiresClient: false,
  input: z.object({
    sessionId: z.string().min(1).describe("Session UUID from session-list."),
    from: z.number().int().positive().optional(),
    to: z.number().int().positive().optional(),
    includeMutating: z
      .boolean()
      .optional()
      .describe("When true, include flagged-mutating tools in the plan (still not auto-run). Default false."),
    dryRun: z
      .boolean()
      .optional()
      .describe("Plan-only mode. The v1 tool never actually replays — this exists for forward compatibility."),
  }),
  async execute({ sessionId, from, to, includeMutating }, ctx) {
    const opts: { from?: number; to?: number } = {};
    if (from !== undefined) opts.from = from;
    if (to !== undefined) opts.to = to;
    const records = await ctx.sessionLogger.read(sessionId, opts);
    const plan = records
      .filter((r) => !r.error) // never replay a step that originally failed
      .map((r) => {
        const blocked = MUTATING_GUARD.has(r.tool);
        if (blocked && !includeMutating) return null;
        return {
          seq: r.seq,
          tool: r.tool,
          input: r.input,
          originalElapsedMs: r.elapsedMs,
          wouldRun: !blocked,
          ...(blocked ? { blockedByDefault: true } : {}),
        };
      })
      .filter(Boolean);
    return {
      data: {
        sessionId,
        steps: plan,
        summary: {
          total: records.length,
          plannable: plan.length,
          skippedErrors: records.filter((r) => r.error).length,
          v1Note:
            "Plan-only in v1. The AI re-issues each step manually (or wraps the trace as a playbook via playbook-save).",
        },
      },
    };
  },
});
