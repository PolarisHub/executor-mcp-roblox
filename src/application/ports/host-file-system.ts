/**
 * Read-only access to the SERVER host filesystem, constrained by the adapter to an
 * allow-list of roots (the working directory, ~/Documents, and any configured
 * script dirs). Used by `execute-file` to load a Luau file before running it on the
 * client. Every method rejects paths that escape the allow-listed roots.
 */
export interface HostFileSystem {
  /** Read a UTF-8 text file. Rejects (ConfigError) if the path is outside the allow-list. */
  readText(path: string): Promise<string>;
  /** List entries in a directory (names only). */
  list(path: string): Promise<readonly string[]>;
  exists(path: string): Promise<boolean>;
  /** The roots this adapter permits, for diagnostics/error messages. */
  readonly allowedRoots: readonly string[];
}
