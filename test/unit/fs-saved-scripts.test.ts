import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsSavedScriptsStore } from "../../src/infrastructure/playbooks/fs-saved-scripts.js";

describe("FsSavedScriptsStore", () => {
  let dir: string;
  let store: FsSavedScriptsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "exec-mcp-pb-"));
    store = new FsSavedScriptsStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves and retrieves a playbook, stamping createdAt/updatedAt", async () => {
    const saved = await store.save({ name: "dump-remotes", source: "return mcp.searchInstances({})" });
    expect(saved.name).toBe("dump-remotes");
    expect(saved.createdAt).toBeTypeOf("number");
    expect(saved.updatedAt).toBeTypeOf("number");

    const loaded = await store.get("dump-remotes");
    expect(loaded?.source).toBe("return mcp.searchInstances({})");
  });

  it("preserves createdAt on upsert", async () => {
    const first = await store.save({ name: "a", source: "return 1" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.save({ name: "a", source: "return 2" });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt!);
    expect(second.source).toBe("return 2");
  });

  it("lists newest-first and filters by tag", async () => {
    await store.save({ name: "old", source: "x", tags: ["recon"] });
    await new Promise((r) => setTimeout(r, 5));
    await store.save({ name: "new", source: "y", tags: ["farming"] });

    const all = await store.list();
    expect(all.map((p) => p.name)).toEqual(["new", "old"]);

    const farming = await store.list({ tag: "farming" });
    expect(farming.map((p) => p.name)).toEqual(["new"]);
  });

  it("rejects unsafe names instead of escaping the dir", async () => {
    await expect(store.save({ name: "../boom", source: "x" })).rejects.toThrow();
    await expect(store.save({ name: "with space", source: "x" })).rejects.toThrow();
    await expect(store.save({ name: "", source: "x" })).rejects.toThrow();
  });

  it("delete returns true once, false thereafter; get returns null for unknown", async () => {
    await store.save({ name: "gone", source: "x" });
    expect(await store.delete("gone")).toBe(true);
    expect(await store.delete("gone")).toBe(false);
    expect(await store.get("gone")).toBeNull();
    expect(await store.get("never-existed")).toBeNull();
  });
});
