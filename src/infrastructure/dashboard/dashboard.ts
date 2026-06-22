import type { Context, Hono } from "hono";

import { toDomainError } from "../../domain/errors/errors.js";
import { buildDashboardState, buildToolCatalog, type DashboardDeps } from "./dashboard-data.js";
import { ExplorerService } from "./dashboard-explorer.js";
import { renderDashboardPage } from "./page.js";

/**
 * Serves the web dashboard and its JSON API on the bridge's HTTP server. The
 * read-only endpoints pull from the application ports (client directory, tool
 * registry, activity log, health). The Explorer endpoints run guarded Luau on a
 * chosen client through the execution gateway to fetch its live game tree.
 */
export class Dashboard {
  private readonly explorer: ExplorerService;

  constructor(private readonly deps: DashboardDeps) {
    this.explorer = new ExplorerService(deps.gateway, deps.clients);
  }

  mount(app: Hono): void {
    app.get("/", (c) => c.html(renderDashboardPage()));
    app.get("/api/state", (c) => c.json(buildDashboardState(this.deps)));
    app.get("/api/tools", (c) => c.json(buildToolCatalog(this.deps.registry)));

    const explore =
      (fn: (clientId: string, path: string) => Promise<unknown>) =>
      async (c: Context): Promise<Response> => {
        const clientId = c.req.query("client") ?? "";
        const path = c.req.query("path") ?? "game";
        if (!clientId) return c.json({ error: "missing ?client" }, 400);
        try {
          return c.json(await fn(clientId, path));
        } catch (thrown) {
          const err = toDomainError(thrown);
          return c.json({ error: err.message, code: err.code }, 502);
        }
      };

    app.get("/api/explore/children", explore((id, p) => this.explorer.children(id, p)));
    app.get("/api/explore/properties", explore((id, p) => this.explorer.properties(id, p)));
    app.get("/api/explore/connections", explore((id, p) => this.explorer.connections(id, p)));
  }
}
