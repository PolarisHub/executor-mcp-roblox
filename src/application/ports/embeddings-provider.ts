/**
 * Turns text into vectors for semantic search. The default adapter talks to a
 * configurable HTTP endpoint (Ollama / OpenAI-compatible) and falls back to a
 * deterministic local embedding when none is configured, so the feature degrades
 * instead of failing.
 */
export interface EmbeddingsProvider {
  /** Identifier of the active model (e.g. "embeddinggemma", "local-hash"). */
  readonly model: string;
  /** Vector dimensionality, or null if variable/unknown until first call. */
  readonly dimensions: number | null;
  /** Embed a batch of texts; returns one vector per input, in order. */
  embed(texts: readonly string[]): Promise<number[][]>;
}
