import type { ActivityLog } from "../../application/ports/activity-log.js";
import type { ClientDirectory } from "../../application/ports/client-directory.js";
import type { AppConfig } from "../../application/ports/config.js";
import type { ToolRegistry } from "../../application/tool/registry.js";
import type { HealthReporter } from "../observability/health.js";

export interface DashboardDeps {
  readonly config: AppConfig;
  readonly clients: ClientDirectory;
  readonly registry: ToolRegistry;
  readonly activity: ActivityLog;
  readonly health: HealthReporter;
}

/** The JSON the dashboard polls. Kept flat and presentational. */
export interface DashboardState {
  readonly server: {
    readonly version: string;
    readonly label: string;
    readonly host: string;
    readonly port: number;
    readonly uptimeMs: number;
    readonly startedAt: number;
  };
  readonly clients: ReadonlyArray<{
    readonly clientId: string;
    readonly username: string | null;
    readonly displayName: string | null;
    readonly userId: number | null;
    readonly placeId: number | null;
    readonly jobId: string | null;
    readonly executor: string | null;
    readonly capabilities: number;
    readonly connectedAt: number;
  }>;
  readonly catalog: {
    readonly total: number;
    readonly categories: ReadonlyArray<{ readonly category: string; readonly count: number }>;
  };
  readonly activity: {
    readonly total: number;
    readonly errors: number;
    readonly recent: ReadonlyArray<{
      readonly toolName: string;
      readonly category: string;
      readonly outcome: "ok" | "error";
      readonly durationMs: number;
      readonly errorCode?: string;
      readonly clientName?: string | null;
      readonly at: number;
    }>;
  };
}

export interface ToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly mutatesState: boolean;
  readonly requiresClient: boolean;
}

export function buildDashboardState(deps: DashboardDeps): DashboardState {
  const health = deps.health.report();
  const summary = deps.activity.summary();
  return {
    server: {
      version: health.version,
      label: deps.config.session.label,
      host: deps.config.server.host,
      port: deps.config.server.port,
      uptimeMs: health.uptimeMs,
      startedAt: health.startedAt,
    },
    clients: deps.clients.list().map((c) => ({
      clientId: c.id,
      username: c.username,
      displayName: c.displayName,
      userId: c.userId,
      placeId: c.placeId,
      jobId: c.jobId,
      executor: c.executor,
      capabilities: c.capabilities.length,
      connectedAt: c.connectedAt,
    })),
    catalog: {
      total: deps.registry.size,
      categories: deps.registry.categoryCounts().map((e) => ({ ...e })),
    },
    activity: {
      total: summary.total,
      errors: summary.errors,
      recent: deps.activity.recent(40).map((r) => ({
        toolName: r.toolName,
        category: r.category,
        outcome: r.outcome,
        durationMs: r.durationMs,
        clientName: r.clientName ?? null,
        at: r.at,
        ...(r.errorCode ? { errorCode: r.errorCode } : {}),
      })),
    },
  };
}

export function buildToolCatalog(registry: ToolRegistry): ToolCatalogEntry[] {
  return registry.list().map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    category: t.category,
    mutatesState: t.mutatesState ?? false,
    requiresClient: t.requiresClient !== false,
  }));
}
