import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context, Hono } from "hono";

import { toDomainError } from "../../domain/errors/errors.js";
import { CLASS_ICON_INDEX } from "./class-icons.js";
import { buildDashboardState, buildToolCatalog, type DashboardDeps } from "./dashboard-data.js";
import { ExplorerService } from "./dashboard-explorer.js";
import { renderDashboardPage } from "./page.js";

/** Roblox Studio's `ClassImages.png` sprite strip, resolved relative to this module. */
const CLASS_ICONS_PNG = join(dirname(fileURLToPath(import.meta.url)), "../../../assets/class-icons.png");

/**
 * Serves the web dashboard and its JSON API on the bridge's HTTP server. The
 * read-only endpoints pull from the application ports (client directory, tool
 * registry, activity log, health). The Explorer endpoints run guarded Luau on a
 * chosen client through the execution gateway to fetch its live game tree.
 */
export class Dashboard {
  private readonly explorer: ExplorerService;
  private classIcons: ArrayBuffer | null = null;

  constructor(private readonly deps: DashboardDeps) {
    this.explorer = new ExplorerService(deps.gateway, deps.clients);
  }

  mount(app: Hono): void {
    app.get("/", (c) => c.html(renderDashboardPage()));
    app.get("/api/state", (c) => c.json(buildDashboardState(this.deps)));
    app.get("/api/tools", (c) => c.json(buildToolCatalog(this.deps.registry)));
    app.get("/api/class-icons", (c) => c.json(CLASS_ICON_INDEX));

    app.get("/assets/class-icons.png", (c) => {
      if (!this.classIcons) {
        try {
          const buf = readFileSync(CLASS_ICONS_PNG);
          this.classIcons = buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength,
          );
        } catch {
          return c.text("class-icons.png not found", 404);
        }
      }
      return c.body(this.classIcons, 200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      });
    });

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
