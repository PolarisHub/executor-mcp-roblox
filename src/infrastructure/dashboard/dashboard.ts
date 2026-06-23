import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context, Hono } from "hono";

import { toDomainError } from "../../domain/errors/errors.js";
import { ClientId } from "../../domain/shared/ids.js";
import { CLASS_ICON_INDEX } from "./class-icons.js";
import { buildDashboardState, buildToolCatalog, type DashboardDeps } from "./dashboard-data.js";
import { ExplorerService } from "./dashboard-explorer.js";
import { renderDashboardPage } from "./page.js";
import { zodToJsonSchema } from "./zod-json-schema.js";

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
    app.get("/api/tools/schema", (c) =>
      c.json(
        this.deps.registry.list().map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          category: tool.category,
          mutatesState: tool.mutatesState ?? false,
          requiresClient: tool.requiresClient !== false,
          inputSchema: zodToJsonSchema(tool.input),
        })),
      ),
    );
    app.get("/api/class-icons", (c) => c.json(CLASS_ICON_INDEX));

    app.get("/api/output", (c) => {
      const client = c.req.query("client") || undefined;
      const raw = c.req.query("limit");
      const parsed = raw === undefined ? NaN : Number(raw);
      const limit = Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 2000) : 500;
      return c.json({ entries: this.deps.output.recent(limit, client) });
    });

    app.post("/api/clients/:id/disconnect", (c) => {
      const id = c.req.param("id");
      if (!id) return c.json({ ok: false, error: "missing client id" }, 400);
      const dropped = this.deps.admin.disconnect(ClientId(id), "disconnected from dashboard");
      if (!dropped) return c.json({ ok: false, error: "client not connected" }, 404);
      return c.json({ ok: true });
    });

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
