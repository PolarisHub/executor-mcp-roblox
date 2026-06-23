import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { EmbeddingsProvider } from "../../application/ports/embeddings-provider.js";

const CACHE_VERSION = 1;

interface CacheFile {
  readonly version: number;
  /** sha256(text) -> vector, partitioned by model name so swapping models is safe. */
  readonly byModel: Record<string, Record<string, number[]>>;
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Wraps another {@link EmbeddingsProvider} with a sha256-keyed on-disk cache so
 * a place's script bodies only have to be embedded once. A 5,000-script place
 * that took ~2 minutes to warm up on first connect re-warms in under a second
 * on subsequent runs — only the *new* scripts hit the underlying provider.
 *
 * The cache is partitioned by model name, so switching from `local-hash` to
 * `embeddinggemma` doesn't poison cached vectors of incompatible dimension.
 * Writes are batched (one fsync per embed() call), not per-entry.
 */
export class CachedEmbeddingsProvider implements EmbeddingsProvider {
  readonly model: string;
  readonly #inner: EmbeddingsProvider;
  readonly #path: string;
  #file: CacheFile;
  #loaded = false;
  /** Lifetime counters surfaced via stats() for diagnostics. */
  private hits = 0;
  private misses = 0;

  constructor(inner: EmbeddingsProvider, cachePath?: string) {
    this.#inner = inner;
    this.model = inner.model;
    this.#path = resolve(
      cachePath ?? join(homedir(), ".executor-mcp", "embeddings.json"),
    );
    this.#file = { version: CACHE_VERSION, byModel: {} };
  }

  get dimensions(): number | null {
    return this.#inner.dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.ensureLoaded();
    const modelCache = this.modelTable();
    const out: number[][] = new Array<number[]>(texts.length);
    const missIndices: number[] = [];
    const missTexts: string[] = [];
    const missHashes: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const key = hashText(text);
      const hit = modelCache[key];
      if (hit) {
        out[i] = hit;
        this.hits += 1;
      } else {
        missIndices.push(i);
        missTexts.push(text);
        missHashes.push(key);
      }
    }

    if (missTexts.length > 0) {
      const fresh = await this.#inner.embed(missTexts);
      for (let i = 0; i < missTexts.length; i++) {
        const vec = fresh[i]!;
        modelCache[missHashes[i]!] = vec;
        out[missIndices[i]!] = vec;
      }
      this.misses += missTexts.length;
      this.flush();
    }

    return out;
  }

  /** Returns cache hit/miss counters and on-disk size for diagnostics. */
  stats(): { hits: number; misses: number; entries: number; bytesOnDisk: number } {
    this.ensureLoaded();
    const entries = Object.keys(this.modelTable()).length;
    let bytesOnDisk = 0;
    try {
      bytesOnDisk = readFileSync(this.#path).byteLength;
    } catch {
      // ENOENT or unreadable; bytesOnDisk stays 0
    }
    return { hits: this.hits, misses: this.misses, entries, bytesOnDisk };
  }

  /** Drop all cached vectors for the current model. Writes through to disk. */
  clearCurrentModel(): void {
    this.ensureLoaded();
    this.#file.byModel[this.model] = {};
    this.flush();
  }

  private modelTable(): Record<string, number[]> {
    const table = this.#file.byModel[this.model];
    if (table) return table;
    const fresh: Record<string, number[]> = {};
    this.#file.byModel[this.model] = fresh;
    return fresh;
  }

  private ensureLoaded(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const raw = readFileSync(this.#path, "utf8");
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version === CACHE_VERSION && parsed.byModel && typeof parsed.byModel === "object") {
        this.#file = parsed;
      }
    } catch {
      // ENOENT / parse-error: start with an empty cache. Don't propagate.
    }
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(this.#path, JSON.stringify(this.#file), "utf8");
    } catch {
      // Best-effort; in-memory cache still works. Don't propagate.
    }
  }
}
