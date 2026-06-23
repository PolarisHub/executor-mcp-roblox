import { randomUUID } from "node:crypto";

import { toDomainError } from "../../domain/errors/errors.js";
import type { ClientId, SessionId } from "../../domain/shared/ids.js";
import type { ToolInvoker } from "./tool-invoker.js";

/** What a minted token is allowed to do: run tools as one session/client. */
interface Grant {
  readonly sessionId: SessionId;
  readonly sessionLabel: string;
  readonly clientId?: ClientId;
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
    budget: number = DEFAULT_SCRIPT_RPC_BUDGET,
  ): { token: string; dispose: () => void } {
    const token = randomUUID();
    this.grants.set(token, {
      sessionId,
      sessionLabel,
      ...(clientId ? { clientId } : {}),
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
      const result = await this.invoker.invoke({
        toolName,
        input: args ?? {},
        sessionId: grant.sessionId,
        sessionLabel: grant.sessionLabel,
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
