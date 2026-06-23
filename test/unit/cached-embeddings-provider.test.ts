import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CachedEmbeddingsProvider } from "../../src/infrastructure/semantic/cached-embeddings-provider.js";
import type { EmbeddingsProvider } from "../../src/application/ports/embeddings-provider.js";

function fakeProvider(model = "embeddinggemma"): {
  provider: EmbeddingsProvider;
  embed: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn(async (texts: readonly string[]) =>
    texts.map((t, i) => [t.length, i + 1, 0.5]),
  );
  return {
    provider: { model, dimensions: 3, embed },
    embed,
  };
}

describe("CachedEmbeddingsProvider", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "exec-mcp-emb-"));
    cachePath = join(dir, "embeddings.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("only calls the inner provider for cache misses", async () => {
    const { provider, embed } = fakeProvider();
    const cache = new CachedEmbeddingsProvider(provider, cachePath);

    const first = await cache.embed(["a", "b", "c"]);
    expect(first).toHaveLength(3);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]![0]).toEqual(["a", "b", "c"]);

    embed.mockClear();
    const second = await cache.embed(["b", "c", "d"]);
    expect(second).toHaveLength(3);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]![0]).toEqual(["d"]); // only the miss
  });

  it("persists across instances via the cache file", async () => {
    const { provider: p1, embed: e1 } = fakeProvider();
    const c1 = new CachedEmbeddingsProvider(p1, cachePath);
    await c1.embed(["alpha", "beta"]);
    expect(e1).toHaveBeenCalledTimes(1);

    const { provider: p2, embed: e2 } = fakeProvider();
    const c2 = new CachedEmbeddingsProvider(p2, cachePath);
    await c2.embed(["alpha", "beta"]);
    expect(e2).not.toHaveBeenCalled();
  });

  it("partitions cache by model so swapping models does not poison vectors", async () => {
    const { provider: p1 } = fakeProvider("embeddinggemma");
    const c1 = new CachedEmbeddingsProvider(p1, cachePath);
    await c1.embed(["x"]);

    const { provider: p2, embed: e2 } = fakeProvider("local-hash");
    const c2 = new CachedEmbeddingsProvider(p2, cachePath);
    await c2.embed(["x"]);
    // different model -> miss even though text matches
    expect(e2).toHaveBeenCalledTimes(1);
  });

  it("stats() reports hits, misses, and entries", async () => {
    const { provider } = fakeProvider();
    const cache = new CachedEmbeddingsProvider(provider, cachePath);

    await cache.embed(["a", "b"]);   // 2 misses
    await cache.embed(["a", "c"]);   // 1 hit, 1 miss
    const s = cache.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(3);
    expect(s.entries).toBe(3);
    expect(s.bytesOnDisk).toBeGreaterThan(0);
  });
});
