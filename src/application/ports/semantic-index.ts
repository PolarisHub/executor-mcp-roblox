import type { ClientId } from "../../domain/shared/ids.js";

/** A script source to be indexed/searched. */
export interface SemanticDocument {
  readonly path: string;
  readonly text: string;
}

export interface SemanticHit {
  readonly path: string;
  /** Cosine similarity in [0, 1]. */
  readonly score: number;
  readonly snippet: string;
}

export interface SemanticStats {
  readonly indexed: boolean;
  readonly documentCount: number;
  readonly model: string | null;
  readonly dimensions: number | null;
}

/**
 * Per-client semantic index over script sources. The caller supplies the current
 * documents lazily (fetched from the client); the index embeds and caches them
 * (keyed by content) so repeated searches are cheap, then returns the nearest
 * matches to a query. Embedding is delegated to an {@link EmbeddingsProvider}.
 */
export interface SemanticIndex {
  /** Ensure `documents` are embedded/cached for the client, then return top `limit` matches. */
  search(
    clientId: ClientId,
    query: string,
    limit: number,
    documents: readonly SemanticDocument[],
  ): Promise<readonly SemanticHit[]>;
  stats(clientId: ClientId): SemanticStats;
  clear(clientId: ClientId): void;
}
