import type { z } from "zod";
import type { RobloxClient } from "../../domain/client/client.js";
import type { ClientSelection, SelectionResolution } from "../../domain/client/selection.js";
import type { ToolCategory } from "../../domain/tool/category.js";
import type { ClientId, SessionId } from "../../domain/shared/ids.js";
import type { ClientDirectory } from "../ports/client-directory.js";
import type { EvalPriority } from "../ports/execution-gateway.js";
import type { HostFileSystem } from "../ports/host-file-system.js";
import type { HostShell } from "../ports/host-shell.js";
import type { Logger } from "../ports/logger.js";
import type { SavedScriptsStore } from "../ports/saved-scripts.js";
import type { SemanticIndex } from "../ports/semantic-index.js";
import type { SessionLogger } from "../ports/session-logger.js";
import type { ToolDirectory } from "../ports/tool-directory.js";

/** Server-host capabilities for the few tools that operate outside the game sandbox. */
export interface HostServices {
  readonly shell: HostShell;
  readonly fs: HostFileSystem;
}

/** Options for a single Luau execution from inside a tool. */
export interface LuauOptions {
  readonly threadContext?: number;
  readonly timeoutMs?: number;
  /** "vm" runs in the persistent VM environment (globals persist across runs). */
  readonly env?: "fresh" | "vm" | "vm-reset";
  /** Per-run token that gates `mcp.*` calls made from inside the script. */
  readonly scriptToken?: string;
  /** Internal scheduler lane. Nested script RPC work gets a reserved slot. */
  readonly priority?: EvalPriority;
}

/** Lets the `script` tool expose the whole tool surface to in-game Luau as `mcp.*`. */
export interface ScriptingContext {
  /** Loopback base URL of this server, reachable from the executor's HTTP client. */
  readonly baseUrl: string;
  /** Mint a one-shot token for the bridge; dispose when done. */
  mint(opts?: { budget?: number }): { token: string; dispose: () => void };
  /** Read-only view of the tool catalog, for the script tool's preflight check. */
  readonly knownTools: readonly string[];
}

/** Per-call session controls handed to session-management tools. */
export interface SessionContext {
  readonly id: SessionId;
  readonly label: string;
  readonly selection: ClientSelection;
  select(selection: ClientSelection): void;
  clear(): void;
  /** Resolve the active client for this session against the live client set. */
  resolve(): SelectionResolution;
}

/** Machine-readable planning hints consumed by AI orchestration and schema introspection. */
export interface ToolContract {
  readonly phase: "observe" | "act" | "verify" | "orchestrate";
  readonly prerequisites: readonly string[];
  readonly consumes: readonly string[];
  readonly produces: readonly string[];
  readonly verifiesWith: readonly string[];
  readonly alternatives: readonly string[];
  readonly requiresCapabilities: readonly string[];
  readonly sideEffects: readonly string[];
  readonly failureRecovery: readonly string[];
}

/** Deterministic quality score produced for every defineTool declaration. */
export interface ToolDefinitionQuality {
  readonly score: number;
  readonly grade: "A" | "B" | "C" | "D" | "F";
  readonly explicitFieldDescriptions: number;
  readonly inferredFieldDescriptions: number;
  readonly issues: readonly string[];
  readonly strengths: readonly string[];
}

/**
 * Everything a tool is allowed to touch. The invoker builds a fresh context per
 * call: it resolves the active client up front (for client-bound tools) and binds
 * {@link runLuau} to it, so a tool never picks a client itself and can never reach
 * another session's game.
 */
export interface ToolContext {
  readonly logger: Logger;
  /** Aborted on timeout or client disconnect; honour it in long operations. */
  readonly signal: AbortSignal;
  /** The resolved active client (undefined for tools with `requiresClient: false`). */
  readonly client: RobloxClient | undefined;
  /** Run Luau on the resolved active client and get the decoded result. */
  runLuau(source: string, options?: LuauOptions): Promise<unknown>;
  /** Run Luau on a specific connected client (used by fanout tools). */
  runLuauOn(clientId: ClientId, source: string, options?: LuauOptions): Promise<unknown>;
  /** Read access to every connected client (for management/diagnostic tools). */
  readonly clients: ClientDirectory;
  /** This call's session + selection controls. */
  readonly session: SessionContext;
  /** Server-host capabilities (filesystem read, OS shell) for host-level tools. */
  readonly host: HostServices;
  /** Per-client semantic script index. */
  readonly semantic: SemanticIndex;
  /** Persistent named-script library (playbooks). */
  readonly playbooks: SavedScriptsStore;
  /** Per-session append-only tool-call trace. */
  readonly sessionLogger: SessionLogger;
  /** Read-only schema view of every registered tool, for introspection tools. */
  readonly tools: ToolDirectory;
  /**
   * Invoke another tool through the same {@link ToolInvoker} the caller is on.
   * Used by `session-replay` to actually re-issue a recorded trace. The call
   * runs under the same session, so its own recorded line is appended (with the
   * usual seq + scriptToken bookkeeping).
   */
  invokeTool(name: string, input: unknown): Promise<ToolResult>;
  /** Tool-calling bridge for the `script` tool (absent for ordinary tools/tests). */
  readonly scripting?: ScriptingContext;
}

/** The value a tool returns. `data` is serialized to the AI client verbatim. */
export interface ToolResult {
  readonly data: unknown;
  /** Optional short human-readable summary surfaced alongside the data. */
  readonly summary?: string;
  /** A handled, tool-level failure (distinct from a thrown DomainError). */
  readonly isError?: boolean;
}

/**
 * A tool is a self-contained, schema-validated capability. Tools depend only on
 * the {@link ToolContext} (ports), which makes them unit-testable with a mock
 * context and free of any transport/SDK knowledge.
 */
export interface Tool<I = unknown> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly input: z.ZodType<I>;
  /** Whether a connected client must be resolved before `execute` (default true). */
  readonly requiresClient?: boolean;
  /** Whether the tool writes live game state (default false) — used for safety labeling. */
  readonly mutatesState?: boolean;
  /** Optional/derived machine-readable planning contract for AI orchestration. */
  readonly ai?: ToolContract;
  /** Definition completeness report used by discovery/help and the quality audit. */
  readonly quality?: ToolDefinitionQuality;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}
