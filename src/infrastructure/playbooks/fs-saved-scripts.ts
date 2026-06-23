import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ValidationError } from "../../domain/errors/errors.js";
import type {
  SavedScript,
  SavedScriptsStore,
} from "../../application/ports/saved-scripts.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Files under `~/.executor-mcp/playbooks/<name>.json`. One JSON document per
 * playbook keeps the format greppable and easy to share — no DB to manage.
 * Filenames are validated so a `name` can never escape the playbook dir.
 */
export class FsSavedScriptsStore implements SavedScriptsStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = resolve(dir ?? join(homedir(), ".executor-mcp", "playbooks"));
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      // Best-effort; save() will surface real errors if the dir is unwritable.
    }
  }

  private pathFor(name: string): string {
    if (!NAME_RE.test(name)) {
      throw new ValidationError(
        `Invalid playbook name "${name}". Use letters, digits, _ and -; 1–64 chars.`,
      );
    }
    return join(this.dir, name + ".json");
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async save(script: SavedScript): Promise<SavedScript> {
    const path = this.pathFor(script.name);
    const now = Date.now();
    const existing = existsSync(path) ? this.readOne(path) : null;
    const record: SavedScript = {
      name: script.name,
      source: script.source,
      ...(script.description !== undefined ? { description: script.description } : {}),
      ...(script.tags !== undefined ? { tags: script.tags } : {}),
      ...(script.params !== undefined ? { params: script.params } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
    return record;
  }

  get(name: string): Promise<SavedScript | null> {
    let path: string;
    try {
      path = this.pathFor(name);
    } catch {
      return Promise.resolve(null);
    }
    if (!existsSync(path)) return Promise.resolve(null);
    return Promise.resolve(this.readOne(path));
  }

  list(filter?: { tag?: string }): Promise<readonly SavedScript[]> {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return Promise.resolve([]);
    }
    const out: SavedScript[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const rec = this.readOne(join(this.dir, entry));
        if (filter?.tag && !(rec.tags ?? []).includes(filter.tag)) continue;
        out.push(rec);
      } catch {
        // Skip malformed file; don't poison the whole list for one bad entry.
      }
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return Promise.resolve(out);
  }

  delete(name: string): Promise<boolean> {
    let path: string;
    try {
      path = this.pathFor(name);
    } catch {
      return Promise.resolve(false);
    }
    if (!existsSync(path)) return Promise.resolve(false);
    try {
      unlinkSync(path);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  private readOne(path: string): SavedScript {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SavedScript;
    // Stat ensures updatedAt isn't lost when a user edits the file by hand.
    if (parsed.updatedAt === undefined) {
      const st = statSync(path);
      return { ...parsed, updatedAt: st.mtimeMs, createdAt: parsed.createdAt ?? st.ctimeMs };
    }
    return parsed;
  }
}
