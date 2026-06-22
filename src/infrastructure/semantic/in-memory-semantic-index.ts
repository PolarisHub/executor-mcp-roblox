import type { ClientId } from "../../domain/shared/ids.js";
import type { EmbeddingsProvider } from "../../application/ports/embeddings-provider.js";
import type {
  SemanticDocument,
  SemanticHit,
  SemanticIndex,
  SemanticStats,
} from "../../application/ports/semantic-index.js";

/** Number of leading characters kept as the human-readable hit snippet. */
const SNIPPET_LENGTH = 200;

/** A cached, embedded document. Keyed by its content hash within a client cache. */
interface CachedEntry {
  readonly path: string;
  readonly vector: number[];
  readonly snippet: string;
}

/**
 * Process-scoped {@link SemanticIndex}. Holds, per client, a cache of embedded
 * documents keyed by content hash, so re-searching an unchanged set of scripts
 * never re-embeds them. Embedding is delegated to the injected
 * {@link EmbeddingsProvider}; scoring is cosine similarity over the cached vectors.
 *
 * The caller supplies the current document set on every search: documents new to
 * the cache are embedded (batched), documents that have disappeared are evicted,
 * and the query is embedded once to rank everything that remains.
 */
export class InMemorySemanticIndex implements SemanticIndex {
  readonly #embeddings: EmbeddingsProvider;
  readonly #caches = new Map<ClientId, Map<string, CachedEntry>>();

  constructor(deps: { embeddings: EmbeddingsProvider }) {
    this.#embeddings = deps.embeddings;
  }

  async search(
    clientId: ClientId,
    query: string,
    limit: number,
    documents: readonly SemanticDocument[],
  ): Promise<readonly SemanticHit[]> {
    const cache = this.#cacheFor(clientId);

    // Map each live document to its content hash and keep the latest snippet/path.
    const liveHashes = new Map<string, SemanticDocument>();
    for (const document of documents) {
      liveHashes.set(hashContent(document.text), document);
    }

    // Evict cached entries whose document is no longer present.
    for (const hash of [...cache.keys()]) {
      if (!liveHashes.has(hash)) cache.delete(hash);
    }

    // Embed any documents not already cached, in a single batch.
    const pending: { hash: string; document: SemanticDocument }[] = [];
    for (const [hash, document] of liveHashes) {
      if (!cache.has(hash)) pending.push({ hash, document });
    }
    if (pending.length > 0) {
      try {
        const vectors = await this.#embeddings.embed(pending.map((p) => p.document.text));
        pending.forEach((entry, index) => {
          const vector = vectors[index];
          if (vector === undefined) return;
          cache.set(entry.hash, {
            path: entry.document.path,
            vector,
            snippet: snippetOf(entry.document.text),
          });
        });
      } catch {
        // Embedding failed: leave the cache as-is and report no hits this call.
        return [];
      }
    }

    if (cache.size === 0) return [];

    let queryVector: number[];
    try {
      const embedded = await this.#embeddings.embed([query]);
      const first = embedded[0];
      if (first === undefined) return [];
      queryVector = first;
    } catch {
      return [];
    }

    const hits: SemanticHit[] = [];
    for (const entry of cache.values()) {
      hits.push({
        path: entry.path,
        score: cosineSimilarity(queryVector, entry.vector),
        snippet: entry.snippet,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, limit));
  }

  stats(clientId: ClientId): SemanticStats {
    const cache = this.#caches.get(clientId);
    const documentCount = cache?.size ?? 0;
    return {
      indexed: documentCount > 0,
      documentCount,
      model: this.#embeddings.model,
      dimensions: this.#embeddings.dimensions,
    };
  }

  clear(clientId: ClientId): void {
    this.#caches.delete(clientId);
  }

  #cacheFor(clientId: ClientId): Map<string, CachedEntry> {
    let cache = this.#caches.get(clientId);
    if (cache === undefined) {
      cache = new Map<string, CachedEntry>();
      this.#caches.set(clientId, cache);
    }
    return cache;
  }
}

/** First {@link SNIPPET_LENGTH} characters of a document, for display. */
function snippetOf(text: string): string {
  return text.slice(0, SNIPPET_LENGTH);
}

/** Cosine similarity of two vectors; 0 when either is zero-length or empty. */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** FNV-1a 32-bit hash of content, rendered as hex — a stable cache key. */
function hashContent(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
