import { ClientNotFoundError, ValidationError } from "../../domain/errors/errors.js";
import { ClientId, SessionId } from "../../domain/shared/ids.js";
import { preflightScript } from "../../application/services/script-preflight.js";
import type { ClientDirectory } from "../../application/ports/client-directory.js";
import type { AppConfig } from "../../application/ports/config.js";
import type { ExecutionGateway } from "../../application/ports/execution-gateway.js";
import type { SavedScript, SavedScriptsStore } from "../../application/ports/saved-scripts.js";
import type { ScriptBridge } from "../../application/services/script-bridge.js";
import type { ToolRegistry } from "../../application/tool/registry.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Backs the dashboard Playbooks tab. Lists/loads/saves/deletes via the
 * SavedScriptsStore, and runs a playbook against a chosen client by mirroring
 * the script tool's bind/execute path (mint scriptToken, ${param} substitution,
 * preflight, runLuau, dispose).
 */
export class PlaybookService {
  constructor(
    private readonly store: SavedScriptsStore,
    private readonly gateway: ExecutionGateway,
    private readonly clients: ClientDirectory,
    private readonly scriptBridge: ScriptBridge,
    private readonly registry: ToolRegistry,
    private readonly config: AppConfig,
  ) {}

  list(): Promise<readonly SavedScript[]> {
    return this.store.list();
  }
  get(name: string): Promise<SavedScript | null> {
    return this.store.get(name);
  }
  save(input: SavedScript): Promise<SavedScript> {
    if (!NAME_RE.test(input.name)) {
      return Promise.reject(
        new ValidationError(
          `Invalid playbook name "${input.name}". Use letters, digits, _ and -; 1–64 chars.`,
        ),
      );
    }
    return this.store.save(input);
  }
  delete(name: string): Promise<boolean> {
    return this.store.delete(name);
  }

  async run(
    name: string,
    clientId: string,
    params: Record<string, string> | undefined,
    options: { persistent?: boolean; timeoutMs?: number; rpcBudget?: number } = {},
  ): Promise<unknown> {
    const cid = ClientId(clientId);
    if (!this.clients.get(cid)) {
      throw new ClientNotFoundError(`Client "${clientId}" is not connected.`);
    }
    const playbook = await this.store.get(name);
    if (!playbook) {
      return { error: `No playbook named "${name}".` };
    }

    const substituted = playbook.source.replace(/\$\$|\$\{([^}]+)\}/g, (m, key: string | undefined) => {
      if (m === "$$") return "$";
      if (params && key !== undefined && Object.hasOwn(params, key)) {
        return String(params[key]);
      }
      return m;
    });

    const knownTools = this.registry.list().map((t) => t.name);
    const preflight = preflightScript(substituted, knownTools);
    if (preflight.errors.length > 0) {
      return {
        error: `preflight: ${preflight.errors.length} unknown mcp.* tool${preflight.errors.length === 1 ? "" : "s"} in playbook "${name}".`,
        unknownTools: preflight.errors.map((f) => ({
          name: f.name,
          writtenAs: f.written,
          occurrences: f.occurrences,
          didYouMean: f.suggestions,
        })),
      };
    }

    // The dashboard isn't tied to an MCP session; mint under a synthetic id
    // dedicated to dashboard-initiated playbook runs.
    const sessionId = SessionId(`dashboard-playbook-${name}`);
    const { token, dispose } = this.scriptBridge.mint(
      sessionId,
      "dashboard-playbook",
      cid,
      options.rpcBudget,
    );
    try {
      return await this.gateway.eval(cid, {
        source: substituted,
        threadContext: this.config.execution.defaultThreadContext,
        timeoutMs: options.timeoutMs ?? 120000,
        env: options.persistent === false ? "fresh" : "vm",
        scriptToken: token,
      });
    } finally {
      dispose();
    }
  }
}
