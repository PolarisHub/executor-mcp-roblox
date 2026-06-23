/**
 * Persistent storage for named, parameterized Luau snippets ("playbooks").
 * Operators and the AI use these to avoid re-deriving the same recipes
 * (hookmetamethod, dumpremotes, findmoney, etc.) every session.
 */
export interface SavedScript {
  readonly name: string;
  readonly source: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  /**
   * Names of `${param}` placeholders the source uses. Run input must provide
   * matching string values; missing keys are left as-is in the rendered source.
   */
  readonly params?: readonly string[];
  /** Epoch millis. Filled by the store on save. */
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface SavedScriptsStore {
  /** Upsert by name. Returns the stored record (with updatedAt set). */
  save(script: SavedScript): Promise<SavedScript>;
  /** Load by name, or null if it doesn't exist. */
  get(name: string): Promise<SavedScript | null>;
  /** List all saved scripts, optionally filtered by tag. Newest-first. */
  list(filter?: { tag?: string }): Promise<readonly SavedScript[]>;
  /** Delete by name. Returns true if a record was removed. */
  delete(name: string): Promise<boolean>;
}
