import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { preflightScript } from "../../application/services/script-preflight.js";
import { ClientId } from "../../domain/shared/ids.js";
import { toDomainError } from "../../domain/errors/errors.js";

/** Concurrency cap: don't blast the same bridge with more than this in flight. */
const MAX_CONCURRENCY = 8;

/**
 * Run one Luau program across multiple connected clients in parallel and
 * aggregate per-client results. Each client gets its own scriptToken (and
 * therefore its own RPC budget), and the same `mcp` table is bound inside —
 * so a fanout body can still call `mcp.*` and `mcp.all()`.
 *
 * The active session's client selection is ignored — explicit targeting only.
 */
export default defineTool({
  name: "script-fanout",
  title: "Run a Luau script on N clients in parallel",
  description:
    "Run ONE Luau program across multiple connected clients in parallel and return per-client results. Targets " +
    "are chosen by either passing `clients: ['<clientId>', ...]` (explicit ids from list-clients) or `clients: 'all'` " +
    "(every connected client). Each client gets its own scriptToken / RPC budget, and the same `mcp.*` surface " +
    "(including `mcp.all()`) is available inside. Concurrency is capped to " + MAX_CONCURRENCY + " in flight so " +
    "a 50-client fanout doesn't saturate the bridge. Returns { results: [{ clientId, displayName, ok, result?, " +
    "error?, output, durationMs }], summary: { total, ok, failed, totalMs } }. Pre-flight catches typo'd mcp.* " +
    "calls before dispatch, so a typo doesn't fail N times.",
  category: "Execution",
  mutatesState: true,
  requiresClient: false,
  input: z.object({
    clients: z
      .union([z.array(z.string()).min(1), z.literal("all")])
      .describe("Either an array of clientIds (from list-clients) or the string 'all'."),
    source: z
      .string()
      .describe(
        "The Luau script to run on every target client. Has the same `mcp.*` surface as the regular script tool.",
      ),
    persistent: z
      .boolean()
      .optional()
      .describe("Each client's persistent VM is independent (default true = use VM env)."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Per-client timeout in ms (default 60000)."),
    rpcBudget: z
      .number()
      .int()
      .positive()
      .max(10000)
      .optional()
      .describe("Per-client mcp.* RPC cap (default 500)."),
    threadContext: z.number().int().optional(),
  }),
  async execute({ clients, source, persistent, timeoutMs, rpcBudget, threadContext }, ctx) {
    if (!ctx.scripting) {
      return {
        data: { error: "The scripting bridge is not available on this server." },
        isError: true,
      };
    }

    // Pre-flight once, server-side: any unknown mcp.X will fail on every
    // client identically, so refuse with a single clear error instead of N.
    const preflight = preflightScript(source, ctx.scripting.knownTools);
    if (preflight.errors.length > 0) {
      return {
        data: {
          error:
            "preflight: " +
            preflight.errors.length +
            " unknown mcp.* tool" +
            (preflight.errors.length === 1 ? "" : "s") +
            " — fix names before fanout.",
          unknownTools: preflight.errors.map((f) => ({
            name: f.name,
            writtenAs: f.written,
            occurrences: f.occurrences,
            didYouMean: f.suggestions,
          })),
        },
        isError: true,
      };
    }

    const connected = ctx.clients.list();
    const targetSet =
      clients === "all"
        ? connected.map((c) => c.id)
        : clients.map((id) => ClientId(id));
    const missing = targetSet.filter((id) => !connected.some((c) => c.id === id));

    if (targetSet.length === 0) {
      return { data: { results: [], summary: { total: 0, ok: 0, failed: 0, totalMs: 0 } } };
    }

    const startedAt = Date.now();
    const runOne = async (
      clientId: ClientId,
    ): Promise<{
      clientId: string;
      displayName: string | null;
      ok: boolean;
      result?: unknown;
      error?: string;
      output?: unknown;
      durationMs: number;
    }> => {
      const client = ctx.clients.get(clientId);
      const displayName = client?.displayName ?? client?.username ?? null;
      const t0 = Date.now();
      // ctx.scripting is non-null by the early-return above, but TS narrowing
      // doesn't follow into the closure — re-assert for the type system.
      const scripting = ctx.scripting!;
      // Bind the token to THIS fanout target so the body's nested mcp.* calls run on
      // the same game (fanout is requiresClient:false, so there is no session client
      // to fall back to — without this they'd re-resolve to the wrong game or error).
      const { token, dispose } = scripting.mint({
        clientId,
        ...(rpcBudget !== undefined ? { budget: rpcBudget } : {}),
      });
      try {
        const data = await ctx.runLuauOn(clientId, source, {
          timeoutMs: timeoutMs ?? 60000,
          env: persistent === false ? "fresh" : "vm",
          scriptToken: token,
          ...(threadContext !== undefined ? { threadContext } : {}),
        });
        return {
          clientId,
          displayName,
          ok: true,
          result: data,
          durationMs: Date.now() - t0,
        };
      } catch (thrown) {
        const err = toDomainError(thrown);
        return {
          clientId,
          displayName,
          ok: false,
          error: err.message,
          durationMs: Date.now() - t0,
        };
      } finally {
        dispose();
      }
    };

    // Bounded-concurrency runner: keep at most MAX_CONCURRENCY runs in flight.
    const results: Awaited<ReturnType<typeof runOne>>[] = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENCY, targetSet.length) },
      async () => {
        while (cursor < targetSet.length) {
          const idx = cursor++;
          const id = targetSet[idx]!;
          results[idx] = await runOne(id);
        }
      },
    );
    await Promise.all(workers);

    const okCount = results.filter((r) => r.ok).length;
    return {
      data: {
        results,
        summary: {
          total: results.length,
          ok: okCount,
          failed: results.length - okCount,
          totalMs: Date.now() - startedAt,
          ...(missing.length ? { unknownClients: missing } : {}),
        },
      },
    };
  },
});
