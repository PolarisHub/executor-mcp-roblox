import { describe, expect, it } from "vitest";
import type { ClientId } from "../../src/domain/shared/ids.js";
import type { EmbeddingsProvider } from "../../src/application/ports/embeddings-provider.js";
import type { SemanticDocument } from "../../src/application/ports/semantic-index.js";
import type { LuauOptions, ToolContext } from "../../src/application/tool/tool.js";
import type { RobloxClient } from "../../src/domain/client/client.js";
import type { SelectionResolution } from "../../src/domain/client/selection.js";
import { InMemorySemanticIndex } from "../../src/infrastructure/semantic/in-memory-semantic-index.js";
import semanticSearchScripts from "../../src/tools/semantic/semantic-search-scripts.js";
import getSemanticIndexStats from "../../src/tools/semantic/get-semantic-index-stats.js";
import clearSemanticIndex from "../../src/tools/semantic/clear-semantic-index.js";
import { semanticTools } from "../../src/tools/semantic/index.js";

const CLIENT: ClientId = "client-1" as ClientId;

/**
 * Deterministic fake provider. Each call counts how many texts it embedded so we
 * can assert caching. Vectors are hand-built so cosine ranking is predictable:
 * a text containing a keyword maps to that keyword's axis.
 */
class FakeEmbeddings implements EmbeddingsProvider {
  readonly model = "fake";
  readonly dimensions = 3;
  embedCount = 0;
  readonly batches: number[] = [];

  // axes: [combat, vehicle, shop]
  async embed(texts: readonly string[]): Promise<number[][]> {
    this.embedCount += texts.length;
    this.batches.push(texts.length);
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return [
        lower.includes("combat") || lower.includes("sword") ? 1 : 0,
        lower.includes("vehicle") || lower.includes("car") ? 1 : 0,
        lower.includes("shop") || lower.includes("buy") ? 1 : 0,
      ];
    });
  }
}

/** A provider that always throws, to exercise the failure guard. */
class ThrowingEmbeddings implements EmbeddingsProvider {
  readonly model = "boom";
  readonly dimensions = null;
  async embed(): Promise<number[][]> {
    throw new Error("backend down");
  }
}

const DOCS: SemanticDocument[] = [
  { path: "game.CombatScript", text: "combat sword damage hit" },
  { path: "game.VehicleScript", text: "vehicle car drive speed" },
  { path: "game.ShopScript", text: "shop buy coins purchase" },
];

describe("InMemorySemanticIndex", () => {
  it("ranks the document closest to the query first by cosine similarity", async () => {
    const embeddings = new FakeEmbeddings();
    const index = new InMemorySemanticIndex({ embeddings });

    const hits = await index.search(CLIENT, "combat sword", 10, DOCS);

    expect(hits).toHaveLength(3);
    expect(hits[0]?.path).toBe("game.CombatScript");
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1);
    // Orthogonal docs score 0 against a combat query.
    expect(hits[1]?.score).toBe(0);
  });

  it("returns a snippet of the first ~200 characters", async () => {
    const embeddings = new FakeEmbeddings();
    const index = new InMemorySemanticIndex({ embeddings });
    const long = "shop ".repeat(80); // 400 chars
    const hits = await index.search(CLIENT, "shop", 1, [{ path: "game.Long", text: long }]);
    expect(hits[0]?.snippet.length).toBe(200);
  });

  it("caches embeddings and does not re-embed unchanged documents", async () => {
    const embeddings = new FakeEmbeddings();
    const index = new InMemorySemanticIndex({ embeddings });

    await index.search(CLIENT, "combat", 10, DOCS);
    // 3 docs + 1 query embedded on the first call.
    expect(embeddings.embedCount).toBe(4);

    await index.search(CLIENT, "vehicle", 10, DOCS);
    // Second call only embeds the new query — docs are cached.
    expect(embeddings.embedCount).toBe(5);
    expect(embeddings.batches).toEqual([3, 1, 1]);
  });

  it("embeds only the newly added document when the set grows", async () => {
    const embeddings = new FakeEmbeddings();
    const index = new InMemorySemanticIndex({ embeddings });

    await index.search(CLIENT, "combat", 10, DOCS.slice(0, 2));
    expect(embeddings.embedCount).toBe(3); // 2 docs + query

    await index.search(CLIENT, "shop", 10, DOCS);
    // Only the third doc + the new query are embedded.
    expect(embeddings.embedCount).toBe(5);
  });

  it("evicts cached documents that disappear from the live set", async () => {
    const embeddings = new FakeEmbeddings();
    const index = new InMemorySemanticIndex({ embeddings });

    await index.search(CLIENT, "combat", 10, DOCS);
    expect(index.stats(CLIENT).documentCount).toBe(3);

    await index.search(CLIENT, "combat", 10, DOCS.slice(0, 1));
    expect(index.stats(CLIENT).documentCount).toBe(1);
  });

  it("honours the limit", async () => {
    const embeddings = new FakeEmbeddings();
    const index = new InMemorySemanticIndex({ embeddings });
    const hits = await index.search(CLIENT, "combat", 2, DOCS);
    expect(hits).toHaveLength(2);
  });

  it("reports stats: indexed flag, document count, model and dimensions", async () => {
    const embeddings = new FakeEmbeddings();
    const index = new InMemorySemanticIndex({ embeddings });

    expect(index.stats(CLIENT)).toEqual({
      indexed: false,
      documentCount: 0,
      model: "fake",
      dimensions: 3,
    });

    await index.search(CLIENT, "combat", 10, DOCS);

    expect(index.stats(CLIENT)).toEqual({
      indexed: true,
      documentCount: 3,
      model: "fake",
      dimensions: 3,
    });
  });

  it("clear() drops the client cache", async () => {
    const embeddings = new FakeEmbeddings();
    const index = new InMemorySemanticIndex({ embeddings });

    await index.search(CLIENT, "combat", 10, DOCS);
    expect(index.stats(CLIENT).indexed).toBe(true);

    index.clear(CLIENT);
    expect(index.stats(CLIENT).documentCount).toBe(0);
    expect(index.stats(CLIENT).indexed).toBe(false);
  });

  it("keeps per-client caches isolated", async () => {
    const embeddings = new FakeEmbeddings();
    const index = new InMemorySemanticIndex({ embeddings });
    const other = "client-2" as ClientId;

    await index.search(CLIENT, "combat", 10, DOCS);
    expect(index.stats(other).documentCount).toBe(0);
    index.clear(CLIENT);
    // Clearing one client never touches another.
    await index.search(other, "shop", 10, DOCS);
    expect(index.stats(other).documentCount).toBe(3);
  });

  it("returns no hits and leaves the cache when embedding fails", async () => {
    const index = new InMemorySemanticIndex({ embeddings: new ThrowingEmbeddings() });
    const hits = await index.search(CLIENT, "combat", 10, DOCS);
    expect(hits).toEqual([]);
    expect(index.stats(CLIENT).documentCount).toBe(0);
  });
});

function makeClient(): RobloxClient {
  return {
    id: CLIENT,
    userId: 100 as never,
    username: "Builderman",
    displayName: "Builderman",
    placeId: 1818,
    jobId: "job-1",
    executor: "Synapse",
    capabilities: [],
    connectedAt: 1_700_000_000_000,
  };
}

/** Mock ToolContext whose runLuau returns canned documents and whose semantic is real. */
function mockContext(opts: {
  semantic: InMemorySemanticIndex;
  runLuauResult?: unknown;
  resolution?: SelectionResolution;
  client?: RobloxClient | undefined;
}): ToolContext & { calls: Array<{ source: string; options?: LuauOptions }> } {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const resolution: SelectionResolution = opts.resolution ?? {
    status: "none",
    reason: "no-clients",
  };
  const ctx = {
    calls,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return ctx.logger;
      },
    },
    signal: new AbortController().signal,
    client: opts.client,
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return opts.runLuauResult ?? [];
    },
    clients: {
      list() {
        return [];
      },
      get() {
        return undefined;
      },
    },
    session: {
      id: "session-abc" as never,
      label: "Session A",
      selection: {} as never,
      select() {},
      clear() {},
      resolve() {
        return resolution;
      },
    },
    host: {} as never,
    semantic: opts.semantic,
  } as unknown as ToolContext & { calls: Array<{ source: string; options?: LuauOptions }> };
  return ctx;
}

describe("Semantic Search tools", () => {
  it("registers all 3 tools, uniquely named, in the Semantic Search category", () => {
    expect(semanticTools).toHaveLength(3);
    const names = semanticTools.map((t) => t.name);
    expect(new Set(names).size).toBe(3);
    expect(names).toEqual([
      "semantic-search-scripts",
      "get-semantic-index-stats",
      "clear-semantic-index",
    ]);
    for (const tool of semanticTools) {
      expect(tool.category).toBe("Semantic Search");
    }
    expect(semanticSearchScripts.requiresClient).toBe(true);
    expect(getSemanticIndexStats.requiresClient).toBe(false);
    expect(clearSemanticIndex.requiresClient).toBe(false);
    // Clearing a server-side cache is not a live-state mutation.
    expect(clearSemanticIndex.mutatesState ?? false).toBe(false);
  });

  describe("semantic-search-scripts", () => {
    it("harvests documents via runLuau, ranks them, and returns hits + model", async () => {
      const embeddings = new FakeEmbeddings();
      const semantic = new InMemorySemanticIndex({ embeddings });
      const canned = [
        { path: "game.CombatScript", text: "combat sword damage" },
        { path: "game.ShopScript", text: "shop buy coins" },
      ];
      const ctx = mockContext({
        semantic,
        runLuauResult: canned,
        client: makeClient(),
        resolution: { status: "resolved", client: makeClient() },
      });

      const input = semanticSearchScripts.input.parse({ query: "buy in the shop" });
      const result = await semanticSearchScripts.execute(input, ctx);

      // It ran exactly one harvest chunk.
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.calls[0]?.source).toContain("GetFullName");

      const data = result.data as {
        hits: Array<{ path: string; score: number; snippet: string }>;
        model: string | null;
      };
      expect(data.model).toBe("fake");
      expect(data.hits).toHaveLength(2);
      expect(data.hits[0]?.path).toBe("game.ShopScript");
    });

    it("defaults limit to 10 and maxScripts to 400", () => {
      const input = semanticSearchScripts.input.parse({ query: "x" });
      expect(input.limit).toBe(10);
      expect(input.maxScripts).toBe(400);
    });

    it("interpolates maxScripts into the harvest chunk", async () => {
      const semantic = new InMemorySemanticIndex({ embeddings: new FakeEmbeddings() });
      const ctx = mockContext({
        semantic,
        runLuauResult: [],
        client: makeClient(),
        resolution: { status: "resolved", client: makeClient() },
      });
      const input = semanticSearchScripts.input.parse({ query: "x", maxScripts: 42 });
      await semanticSearchScripts.execute(input, ctx);
      expect(ctx.calls[0]?.source).toContain("local maxScripts = 42");
    });

    it("tolerates a non-array harvest result by indexing nothing", async () => {
      const semantic = new InMemorySemanticIndex({ embeddings: new FakeEmbeddings() });
      const ctx = mockContext({
        semantic,
        runLuauResult: null,
        client: makeClient(),
        resolution: { status: "resolved", client: makeClient() },
      });
      const input = semanticSearchScripts.input.parse({ query: "x" });
      const result = await semanticSearchScripts.execute(input, ctx);
      expect((result.data as { hits: unknown[] }).hits).toEqual([]);
    });
  });

  describe("get-semantic-index-stats", () => {
    it("returns the active client's stats when resolved", async () => {
      const embeddings = new FakeEmbeddings();
      const semantic = new InMemorySemanticIndex({ embeddings });
      await semantic.search(CLIENT, "combat", 10, DOCS);
      const ctx = mockContext({
        semantic,
        resolution: { status: "resolved", client: makeClient() },
      });

      const result = await getSemanticIndexStats.execute({}, ctx);
      expect(result.data).toEqual({
        indexed: true,
        documentCount: 3,
        model: "fake",
        dimensions: 3,
      });
    });

    it("returns an empty, not-indexed summary when no client resolves", async () => {
      const semantic = new InMemorySemanticIndex({ embeddings: new FakeEmbeddings() });
      const ctx = mockContext({ semantic });
      const result = await getSemanticIndexStats.execute({}, ctx);
      expect(result.data).toEqual({
        indexed: false,
        documentCount: 0,
        model: null,
        dimensions: null,
      });
    });
  });

  describe("clear-semantic-index", () => {
    it("clears the active client's index when resolved", async () => {
      const semantic = new InMemorySemanticIndex({ embeddings: new FakeEmbeddings() });
      await semantic.search(CLIENT, "combat", 10, DOCS);
      const ctx = mockContext({
        semantic,
        resolution: { status: "resolved", client: makeClient() },
      });

      const result = await clearSemanticIndex.execute({}, ctx);
      expect(result.data).toEqual({ cleared: true });
      expect(semantic.stats(CLIENT).indexed).toBe(false);
    });

    it("reports cleared:false when no client resolves", async () => {
      const semantic = new InMemorySemanticIndex({ embeddings: new FakeEmbeddings() });
      const ctx = mockContext({ semantic });
      const result = await clearSemanticIndex.execute({}, ctx);
      expect(result.data).toEqual({ cleared: false });
    });
  });
});
