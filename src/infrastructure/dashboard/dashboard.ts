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
    // Optional auth gate. When the bridge has an authToken configured, every
    // dashboard route requires the same token via a session cookie or the
    // initial /auth POST. Reading the token from the same env var as the
    // bridge means operators configure once.
    const expected = this.deps.config.bridge.authToken;
    if (expected) {
      this.mountAuth(app, expected);
      app.use("/*", async (c, next) => {
        const path = new URL(c.req.url).pathname;
        if (path === "/auth" || path === "/login") return next();
        const cookie = c.req.header("cookie") ?? "";
        const got = /(?:^|;\s*)executor-mcp-token=([^;]+)/.exec(cookie);
        if (got?.[1] === expected) return next();
        // Allow header-based auth for programmatic clients.
        if (c.req.header("x-executor-mcp-token") === expected) return next();
        if (path.startsWith("/api/") || path.startsWith("/ws/")) {
          return c.json({ error: "unauthorized" }, 401);
        }
        return c.html(renderLoginPage(), 401);
      });
    }
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

    app.post("/api/script/run", async (c) => {
      let body: {
        clientId?: unknown;
        source?: unknown;
        persistent?: unknown;
        timeoutMs?: unknown;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const clientId = typeof body.clientId === "string" ? body.clientId : "";
      const source = typeof body.source === "string" ? body.source : "";
      if (!clientId) return c.json({ error: "body.clientId is required" }, 400);
      if (!source) return c.json({ error: "body.source is required" }, 400);
      try {
        const data = await this.playbookSvc.runSource(source, clientId, {
          ...(typeof body.persistent === "boolean" ? { persistent: body.persistent } : {}),
          ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
        });
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

  /**
   * Mount /auth (POST) and /login (GET) BEFORE the gate so the login flow
   * itself doesn't 401. POST /auth validates the supplied token, sets an
   * HttpOnly cookie, then 302s back to /.
   */
  private mountAuth(app: Hono, expected: string): void {
    app.get("/login", (c) => c.html(renderLoginPage()));
    app.post("/auth", async (c) => {
      let body: { token?: unknown } | null = null;
      const ct = c.req.header("content-type") ?? "";
      try {
        if (ct.includes("application/json")) {
          body = (await c.req.json());
        } else {
          const form = await c.req.formData();
          body = { token: form.get("token") };
        }
      } catch {
        return c.json({ ok: false, error: "invalid body" }, 400);
      }
      const provided = typeof body?.token === "string" ? body.token : "";
      if (provided !== expected) {
        if (ct.includes("application/json")) return c.json({ ok: false, error: "bad token" }, 401);
        return c.html(renderLoginPage("Wrong token, try again."), 401);
      }
      // 30d HttpOnly cookie. SameSite=Strict so it never leaks cross-origin.
      c.header(
        "Set-Cookie",
        `executor-mcp-token=${encodeURIComponent(expected)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
      );
      if (ct.includes("application/json")) return c.json({ ok: true });
      return c.redirect("/", 302);
    });
  }
}

/** Minimal sign-in HTML — same dark theme, no JS framework. */
function renderLoginPage(message?: string): string {
  const msg = message ? `<div style="color:#e25c54;margin-bottom:12px;font-size:13px">${escapeHtml(message)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Roblox Executor MCP — Sign in</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; }
  body {
    background: #141414; color: #e6e6e6;
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: grid; place-items: center;
  }
  .card {
    background: #1b1b1b; border: 1px solid #2a2a2a; border-radius: 12px;
    padding: 26px 28px 24px; width: 320px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  }
  h1 { margin: 0 0 4px; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  p.sub { margin: 0 0 16px; color: #6b6b6b; font-size: 12.5px; }
  input[type="password"] {
    width: 100%; box-sizing: border-box;
    background: #101012; border: 1px solid #2a2a2a; border-radius: 8px;
    color: #e6e6e6; font: inherit; padding: 9px 12px; outline: none;
    margin-bottom: 12px;
  }
  input[type="password"]:focus { border-color: #3a3a3a; }
  button {
    appearance: none; background: #6b9bff; border: 1px solid #6b9bff; color: #fff;
    font: inherit; font-weight: 500; padding: 9px 14px; border-radius: 8px; cursor: pointer;
    width: 100%;
  }
  button:hover { background: #5a8cf7; }
</style>
</head><body>
<form class="card" method="POST" action="/auth">
  <h1>Roblox Executor MCP</h1>
  <p class="sub">Enter the bridge token to access the dashboard.</p>
  ${msg}
  <input type="password" name="token" autocomplete="off" autofocus placeholder="ROBLOX_MCP_BRIDGE_TOKEN" />
  <button type="submit">Sign in</button>
</form>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
