import { randomUUID } from "node:crypto";

import { toDomainError } from "../../domain/errors/errors.js";
import type { ClientId, SessionId } from "../../domain/shared/ids.js";
import type { ToolInvoker } from "./tool-invoker.js";

/** What a minted token is allowed to do: run tools as one session/client. */
interface Grant {
  readonly sessionId: SessionId;
  readonly sessionLabel: string;
  readonly clientId?: ClientId;
  /** The parent script's agent lane, forwarded onto nested calls for isolation. */
  readonly agentLane?: string;
  /** Max RPC calls this script may make through the bridge before further calls reject. */
  readonly budget: number;
  /** Running count of RPC calls served for this token. */
  rpcCount: number;
}

/** Per-script RPC budget cap (configurable per mint call). */
export const DEFAULT_SCRIPT_RPC_BUDGET = 500;

export type ScriptRunResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: string; readonly code?: string };

/**
 * Backs the in-game `mcp.<tool>()` bridge. The `script` tool mints a short-lived
 * token bound to its own session/client; the running Luau then calls the
 * token-gated `/api/exec-tool` endpoint, which routes here to run any tool through
 * the normal {@link ToolInvoker}. Tokens gate the endpoint so arbitrary game code
 * can't drive the tool surface — only a script the operator launched can.
 */
export class ScriptBridge {
  private invoker: ToolInvoker | null = null;
  private readonly grants = new Map<string, Grant>();

  /** Wired after construction to break the invoker <-> bridge cycle. */
  attach(invoker: ToolInvoker): void {
    this.invoker = invoker;
  }

  /** Issue a token for one script run. Call `dispose()` when the run finishes. */
  mint(
    sessionId: SessionId,
    sessionLabel: string,
    clientId?: ClientId,
    agentLane?: string,
    budget: number = DEFAULT_SCRIPT_RPC_BUDGET,
  ): { token: string; dispose: () => void } {
    const token = randomUUID();
    this.grants.set(token, {
      sessionId,
      sessionLabel,
      ...(clientId ? { clientId } : {}),
      ...(agentLane ? { agentLane } : {}),
      budget: Math.max(1, Math.floor(budget)),
      rpcCount: 0,
    });
    return { token, dispose: () => void this.grants.delete(token) };
  }

  /** Run a tool on behalf of a token. Never throws — failures come back as data. */
  async run(token: string, toolName: string, args: unknown): Promise<ScriptRunResult> {
    const grant = this.grants.get(token);
    if (!grant) return { ok: false, error: "invalid or expired script token" };
    if (!this.invoker) return { ok: false, error: "scripting bridge is not ready" };
    if (toolName === "script") {
      return { ok: false, error: "script cannot call itself (mcp.script is disabled)" };
    }
    if (grant.rpcCount >= grant.budget) {
      return {
        ok: false,
        error: `script RPC budget exhausted (${grant.budget} calls used). Pass a larger { rpcBudget } to script or split into multiple runs.`,
        code: "BUDGET_EXCEEDED",
      };
    }
    grant.rpcCount += 1;
    try {
      // Pin every nested mcp.* call to the SAME game AND agent lane the script runs
      // in, so a script keeps every sub-call on its own game / VM / fairness lane —
      // never re-resolving through the session's selection (which may be unset,
      // ambiguous, or pointing at a different game). Explicit `client`/`agent` in the
      // nested args still win.
      const provided =
        typeof args === "object" && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : undefined;
      const inject: Record<string, unknown> = {};
      if (grant.clientId !== undefined) inject["client"] = grant.clientId;
      if (grant.agentLane !== undefined) inject["agent"] = grant.agentLane;
      let input: unknown = args ?? {};
      if (Object.keys(inject).length > 0) {
        if (provided) {
          const out: Record<string, unknown> = { ...provided };
          for (const [k, v] of Object.entries(inject)) if (out[k] === undefined) out[k] = v;
          input = out;
        } else if (args === undefined || args === null) {
          input = inject;
        }
      }
      // A nested call aimed at a DIFFERENT game than the script's own must not ride
      // that game's reserved nested lane (which exists for a script actually running
      // there) — otherwise one agent could queue-jump another agent's game. Only the
      // script's own game keeps the nested priority; anything else competes fairly.
      const explicitClient = provided?.["client"];
      const crossConnection =
        typeof explicitClient === "string" &&
        grant.clientId !== undefined &&
        explicitClient !== grant.clientId;
      const result = await this.invoker.invoke({
        toolName,
        input,
        sessionId: grant.sessionId,
        sessionLabel: grant.sessionLabel,
        priority: crossConnection ? "normal" : "nested",
      });
      if (result.isError) {
        const message = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
        return { ok: false, error: message };
      }
      return { ok: true, data: result.data };
    } catch (thrown) {
      const error = toDomainError(thrown);
      return { ok: false, error: error.message, code: error.code };
    }
  }
}
