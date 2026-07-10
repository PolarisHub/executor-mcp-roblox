import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import type { ActivityRecord } from "../../../src/application/ports/activity-log.js";
import { ToolRegistry } from "../../../src/application/tool/registry.js";
import { SessionId } from "../../../src/domain/shared/ids.js";
import {
  buildDashboardState,
  type DashboardDeps,
} from "../../../src/infrastructure/dashboard/dashboard-data.js";
import { renderDashboardPage } from "../../../src/infrastructure/dashboard/page.js";
import { InMemoryActivityLog } from "../../../src/infrastructure/observability/in-memory-activity-log.js";
import { HealthReporter } from "../../../src/infrastructure/observability/health.js";
import { fakeClock, InMemoryClientDirectory } from "../../helpers/fakes.js";

describe("dashboard intelligence", () => {
  it("preserves intelligence metadata in the polling state", () => {
    const activity = new InMemoryActivityLog();
    const record: ActivityRecord = {
      toolName: "resolve-entity",
      category: "Intelligence",
      sessionId: SessionId("dashboard-intelligence"),
      outcome: "ok",
      durationMs: 18,
      at: 1_725_000_000_000,
      intelligence: {
        phase: "resolve",
        status: "resolved",
        confidence: 0.92,
        target: "Workspace.CustomAvatar.Root",
        evidenceCount: 4,
        summary: "Resolved the custom root from its stable handle.",
      },
    };
    activity.record(record);

    const clients = new InMemoryClientDirectory();
    const clock = fakeClock(10_000);
    const deps: DashboardDeps = {
      config: {
        server: { host: "127.0.0.1", port: 16384 },
        session: { id: SessionId("dashboard-intelligence"), label: "test" },
        logging: { level: "info", pretty: false },
        execution: { defaultTimeoutMs: 30_000, defaultThreadContext: 0, scriptDirs: [] },
        semantic: { embeddingsUrl: null, embeddingsModel: "test" },
        bridge: { heartbeatIntervalMs: 5_000, authToken: null },
        dashboard: { enabled: true },
      },
      clients,
      registry: new ToolRegistry(),
      activity,
      health: new HealthReporter({ clock, clients, version: "test" }),
      gateway: {} as DashboardDeps["gateway"],
      output: {} as DashboardDeps["output"],
      admin: {} as DashboardDeps["admin"],
      playbooks: {} as DashboardDeps["playbooks"],
      scriptBridge: {} as DashboardDeps["scriptBridge"],
    };

    const state = buildDashboardState(deps);

    expect(state.activity.recent[0]).toMatchObject({
      toolName: "resolve-entity",
      category: "Intelligence",
      sessionId: "dashboard-intelligence",
      intelligence: record.intelligence,
    });
    expect(state.activity.recent[0]?.intelligence).not.toBe(record.intelligence);
  });

  it("renders an accessible, bounded, event-driven intelligence timeline", () => {
    const page = renderDashboardPage();
    const existingTabs = [
      "clients",
      "tools",
      "activity",
      "explorer",
      "brief",
      "spy",
      "playbooks",
      "repl",
      "output",
    ];

    for (const tab of existingTabs) expect(page).toContain(`data-tab="${tab}"`);
    expect(page).toContain('data-tab="intelligence"');
    expect(page).toContain('id="panel-intelligence"');
    expect(page).toContain('aria-label="Intelligence timeline"');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain("var INTELLIGENCE_HISTORY_LIMIT = 24;");
    expect(page).toContain("records.slice(0, INTELLIGENCE_HISTORY_LIMIT)");
    expect(page).toContain('observe: "Observed"');
    expect(page).toContain('verify: "Verified"');
    expect(page).toContain('recover: "Recovered"');
    expect(page).toContain("refreshIntelligenceBadge(intelRecords)");
    expect(page).toContain("prefers-reduced-motion: reduce");
    expect(page).toContain(".live-scene");
    expect(page).not.toContain("requestAnimationFrame");

    const embeddedScript = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1];
    expect(embeddedScript).toBeDefined();
    expect(() => new Script(embeddedScript ?? "}")).not.toThrow();
  });
});
