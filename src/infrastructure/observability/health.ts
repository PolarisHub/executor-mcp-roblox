import type { Clock } from "../../application/ports/clock.js";
import type { ClientDirectory } from "../../application/ports/client-directory.js";
import type { BridgeLoadSnapshot } from "../../application/ports/client-directory.js";

/** The payload returned by the `/health` endpoint. */
export interface HealthReport {
  readonly service: "executor-mcp-roblox";
  readonly status: "ok";
  readonly uptimeMs: number;
  readonly startedAt: number;
  readonly connectedClients: number;
  readonly version: string;
  readonly bridgeLoad?: Omit<BridgeLoadSnapshot, "clients">;
}

export interface HealthReporterDeps {
  readonly clock: Clock;
  readonly clients: ClientDirectory;
  readonly version: string;
}

/**
 * Produces liveness/readiness snapshots for the dashboard and `/health`. Captures
 * the process start time from the injected {@link Clock} at construction so uptime
 * is measured against the same time source used everywhere else.
 */
export class HealthReporter {
  private readonly clock: Clock;
  private readonly clients: ClientDirectory;
  private readonly version: string;
  private readonly startedAt: number;

  constructor(deps: HealthReporterDeps) {
    this.clock = deps.clock;
    this.clients = deps.clients;
    this.version = deps.version;
    this.startedAt = deps.clock.now();
  }

  report(): HealthReport {
    const bridgeLoad = this.clients.loadSnapshot?.();
    return {
      service: "executor-mcp-roblox",
      status: "ok",
      uptimeMs: this.clock.now() - this.startedAt,
      startedAt: this.startedAt,
      connectedClients: this.clients.list().length,
      version: this.version,
      ...(bridgeLoad
        ? {
            bridgeLoad: {
              activeEvals: bridgeLoad.activeEvals,
              queuedEvals: bridgeLoad.queuedEvals,
              queuedSourceBytes: bridgeLoad.queuedSourceBytes,
              activeRpcFrames: bridgeLoad.activeRpcFrames,
              queuedRpcFrames: bridgeLoad.queuedRpcFrames,
              rejectedEvals: bridgeLoad.rejectedEvals,
              saturatedClients: bridgeLoad.saturatedClients,
            },
          }
        : {}),
    };
  }
}
