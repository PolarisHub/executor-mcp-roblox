import type { Hono } from "hono";

import { buildDashboardState, buildToolCatalog, type DashboardDeps } from "./dashboard-data.js";
import { renderDashboardPage } from "./page.js";

/**
 * Serves the web dashboard and its JSON API on the bridge's HTTP server. It only
 * reads from the application ports (client directory, tool registry, activity
 * log, health) — it never reaches past them or mutates anything.
 */
export class Dashboard {
  constructor(private readonly deps: DashboardDeps) {}

  mount(app: Hono): void {
    app.get("/", (c) => c.html(renderDashboardPage()));
    app.get("/api/state", (c) => c.json(buildDashboardState(this.deps)));
    app.get("/api/tools", (c) => c.json(buildToolCatalog(this.deps.registry)));
  }
}
