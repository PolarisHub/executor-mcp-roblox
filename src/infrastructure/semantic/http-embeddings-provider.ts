import type { AppConfig } from "../../application/ports/config.js";
import type { EmbeddingsProvider } from "../../application/ports/embeddings-provider.js";

/** Dimensionality of the deterministic local fallback embedding. */
const LOCAL_DIMENSIONS = 256;
/** Sentinel model name used when no HTTP endpoint is configured. */
const LOCAL_MODEL = "local-hash";

/**
 * Default {@link EmbeddingsProvider}. When `embeddingsUrl` is configured it POSTs
 * to an external embeddings service (Ollama or OpenAI-compatible) via global
 * `fetch`. When no URL is configured it falls back to a deterministic, dependency-
 * free local embedding so semantic search degrades gracefully instead of failing.
 *
 * The local embedding hashes each lowercased word token of a text into a fixed
 * {@link LOCAL_DIMENSIONS}-wide vector and L2-normalizes it, which makes cosine
 * similarity between two texts meaningful (shared tokens raise the dot product).
 */
export class HttpEmbeddingsProvider implements EmbeddingsProvider {
  readonly model: string;
  /** Local embedding has a fixed width; HTTP width is unknown until the first response. */
  #dimensions: number | null;

  readonly #url: string | null;

  constructor(config: AppConfig["semantic"]) {
    this.#url = config.embeddingsUrl;
    if (config.embeddingsUrl === null) {
      this.model = LOCAL_MODEL;
      this.#dimensions = LOCAL_DIMENSIONS;
    } else {
      this.model = config.embeddingsModel;
      this.#dimensions = null;
    }
  }

  get dimensions(): number | null {
    return this.#dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.#url === null) {
      return texts.map((text) => embedLocally(text, LOCAL_DIMENSIONS));
    }

    const url = this.#url;
    const isOllama = url.endsWith("/api/embeddings");
    const vectors: number[][] = [];
    for (const text of texts) {
      const vector = isOllama
        ? await this.#embedOllama(url, text)
        : await this.#embedOpenAi(url, text);
      vectors.push(vector);
    }
    if (vectors.length > 0) {
      const first = vectors[0];
      if (first !== undefined) this.#dimensions = first.length;
    }
    return vectors;
  }

  async #embedOllama(url: string, text: string): Promise<number[]> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!response.ok) {
      throw new Error(`Embeddings request failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as { embedding?: unknown };
    return asVector(body.embedding);
  }

  async #embedOpenAi(url: string, text: string): Promise<number[]> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!response.ok) {
      throw new Error(`Embeddings request failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as { data?: readonly { embedding?: unknown }[] };
    const first = body.data?.[0];
    return asVector(first?.embedding);
  }
}

/** Coerce an unknown JSON value into a numeric vector, rejecting malformed shapes. */
function asVector(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error("Embeddings response did not contain a numeric vector.");
  }
  const vector = value.map((entry) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new Error("Embeddings response vector contained a non-finite value.");
    }
    return entry;
  });
  return vector;
}

/**
 * Deterministic local embedding: bucket each lowercased word token into the
 * vector by a stable hash, then L2-normalize. No clock, no randomness — the same
 * text always maps to the same unit vector.
 */
function embedLocally(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g);
  if (tokens !== null) {
    for (const token of tokens) {
      const bucket = stableHash(token) % dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
  }
  let magnitude = 0;
  for (const component of vector) magnitude += component * component;
  magnitude = Math.sqrt(magnitude);
  if (magnitude === 0) return vector;
  return vector.map((component) => component / magnitude);
}

/** FNV-1a style 32-bit string hash. Stable, allocation-free, no Date/random. */
function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
