import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context, Hono } from "hono";

import { toDomainError } from "../../domain/errors/errors.js";
import { ClientId } from "../../domain/shared/ids.js";
import { BriefService } from "./dashboard-brief.js";
import { CLASS_ICON_INDEX } from "./class-icons.js";
import { buildDashboardState, buildToolCatalog, type DashboardDeps } from "./dashboard-data.js";
import { ExplorerService } from "./dashboard-explorer.js";
import { PlaybookService } from "./dashboard-playbooks.js";
import { SpyService } from "./dashboard-spy.js";
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
  private readonly brief: BriefService;
  private readonly spy: SpyService;
  private readonly playbookSvc: PlaybookService;
  private classIcons: ArrayBuffer | null = null;

  constructor(private readonly deps: DashboardDeps) {
    this.explorer = new ExplorerService(deps.gateway, deps.clients);
    this.brief = new BriefService(deps.gateway, deps.clients);
    this.spy = new SpyService(deps.gateway, deps.clients);
    this.playbookSvc = new PlaybookService(
      deps.playbooks,
      deps.gateway,
      deps.clients,
      deps.scriptBridge,
      deps.registry,
      deps.config,
    );
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

    app.get("/api/brief", async (c) => {
      const clientId = c.req.query("client") ?? "";
      if (!clientId) return c.json({ error: "missing ?client" }, 400);
      try {
        return c.json(await this.brief.summary(clientId));
      } catch (thrown) {
        const err = toDomainError(thrown);
        return c.json({ error: err.message, code: err.code }, 502);
      }
    });
    app.get("/api/playbooks", async (c) => {
      const items = await this.playbookSvc.list();
      return c.json({
        total: items.length,
        playbooks: items.map((p) => ({
          name: p.name,
          description: p.description ?? null,
          tags: p.tags ?? [],
          params: p.params ?? [],
          createdAt: p.createdAt ?? null,
          updatedAt: p.updatedAt ?? null,
        })),
      });
    });
    app.get("/api/playbooks/:name", async (c) => {
      const name = c.req.param("name");
      if (!name) return c.json({ error: "missing name" }, 400);
      const pb = await this.playbookSvc.get(name);
      if (!pb) return c.json({ error: `No playbook "${name}".` }, 404);
      return c.json(pb);
    });
    app.put("/api/playbooks/:name", async (c) => {
      const name = c.req.param("name");
      if (!name) return c.json({ error: "missing name" }, 400);
      let body: { source?: unknown; description?: unknown; tags?: unknown; params?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (typeof body.source !== "string" || body.source.length === 0) {
        return c.json({ error: "body must include non-empty source: string" }, 400);
      }
      try {
        const saved = await this.playbookSvc.save({
          name,
          source: body.source,
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
          ...(Array.isArray(body.params) ? { params: body.params as string[] } : {}),
        });
        return c.json({ ok: true, name: saved.name, updatedAt: saved.updatedAt });
      } catch (thrown) {
        const err = toDomainError(thrown);
        return c.json({ ok: false, error: err.message, code: err.code }, 400);
      }
    });
    app.delete("/api/playbooks/:name", async (c) => {
      const name = c.req.param("name");
      if (!name) return c.json({ error: "missing name" }, 400);
      const removed = await this.playbookSvc.delete(name);
      return c.json({ ok: true, removed });
    });
    app.post("/api/playbooks/:name/run", async (c) => {
      const name = c.req.param("name");
      if (!name) return c.json({ error: "missing name" }, 400);
      let body: { clientId?: unknown; params?: unknown; persistent?: unknown; timeoutMs?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const clientId = typeof body.clientId === "string" ? body.clientId : "";
      if (!clientId) return c.json({ error: "body.clientId is required" }, 400);
      try {
        const data = await this.playbookSvc.run(
          name,
          clientId,
          (body.params as Record<string, string> | undefined) ?? undefined,
          {
            ...(typeof body.persistent === "boolean" ? { persistent: body.persistent } : {}),
            ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
          },
        );
        return c.json({ ok: true, data });
      } catch (thrown) {
        const err = toDomainError(thrown);
        return c.json({ ok: false, error: err.message, code: err.code }, 502);
      }
    });

    app.get("/api/spy/logs", async (c) => {
      const clientId = c.req.query("client") ?? "";
      if (!clientId) return c.json({ error: "missing ?client" }, 400);
      const limit = Number(c.req.query("limit")) || 200;
      try {
        return c.json(await this.spy.logs(clientId, limit));
      } catch (thrown) {
        const err = toDomainError(thrown);
        return c.json({ error: err.message, code: err.code }, 502);
      }
    });
    app.post("/api/spy/clear", async (c) => {
      const clientId = c.req.query("client") ?? "";
      if (!clientId) return c.json({ error: "missing ?client" }, 400);
      try {
        return c.json(await this.spy.clear(clientId));
      } catch (thrown) {
        const err = toDomainError(thrown);
        return c.json({ error: err.message, code: err.code }, 502);
      }
    });

    app.get("/api/brief/values", async (c) => {
      const clientId = c.req.query("client") ?? "";
      if (!clientId) return c.json({ error: "missing ?client" }, 400);
      const limit = Number(c.req.query("limit")) || 50;
      try {
        return c.json(await this.brief.values(clientId, limit));
      } catch (thrown) {
        const err = toDomainError(thrown);
        return c.json({ error: err.message, code: err.code }, 502);
      }
    });

    app.get("/api/explore/children", async (c) => {
      const clientId = c.req.query("client") ?? "";
      const path = c.req.query("path") ?? "game";
      if (!clientId) return c.json({ error: "missing ?client" }, 400);
      const offsetRaw = c.req.query("offset");
      const limitRaw = c.req.query("limit");
      const offset = offsetRaw !== undefined ? Number(offsetRaw) : undefined;
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      try {
        return c.json(
          await this.explorer.children(clientId, path, {
            ...(Number.isFinite(offset) ? { offset: offset! } : {}),
            ...(Number.isFinite(limit) ? { limit: limit! } : {}),
          }),
        );
      } catch (thrown) {
        const err = toDomainError(thrown);
        return c.json({ error: err.message, code: err.code }, 502);
      }
    });
    app.get("/api/explore/properties", explore((id, p) => this.explorer.properties(id, p)));
    app.get("/api/explore/connections", explore((id, p) => this.explorer.connections(id, p)));
  }
}
