import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { HostFileSystem } from "../../application/ports/host-file-system.js";
import { ConfigError } from "../../domain/errors/errors.js";

/**
 * Filesystem adapter that confines every read to an allow-list of roots. Each
 * input path is resolved to an absolute, symlink-free real path and rejected
 * (with a {@link ConfigError}) unless it is equal to, or nested under, one of the
 * configured roots.
 *
 * The realpath step is what defends against symlink escape: a symlink planted
 * inside an allowed root that points elsewhere resolves to its true target
 * before the containment check, so it can never read outside the allow-list.
 * Roots are canonicalized per call too, so a symlinked root still matches.
 */
export class SandboxedHostFileSystem implements HostFileSystem {
  /** The roots as configured (absolute, normalized) for diagnostics + matching. */
  private readonly roots: readonly string[];

  constructor(allowedRoots: readonly string[]) {
    const configured: string[] = [];
    for (const root of allowedRoots) {
      const abs = resolve(root);
      if (!configured.includes(abs)) configured.push(abs);
    }
    this.roots = configured;
  }

  get allowedRoots(): readonly string[] {
    return this.roots;
  }

  async readText(path: string): Promise<string> {
    const safe = await this.resolveWithinRoots(path);
    return readFile(safe, "utf8");
  }

  async list(path: string): Promise<readonly string[]> {
    const safe = await this.resolveWithinRoots(path);
    return readdir(safe);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.resolveWithinRoots(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve an input path to an absolute real path and assert it lies inside one
   * of the allowed roots. Throws {@link ConfigError} on any rejection: a path
   * that does not exist, a symlink that escapes, or a path outside the allow-list.
   */
  private async resolveWithinRoots(input: string): Promise<string> {
    if (typeof input !== "string" || input.trim() === "") {
      throw new ConfigError("No path provided.", { allowedRoots: this.roots });
    }

    const absolute = resolve(input);

    // lstat first so a symlink AT the target is detected before we follow it.
    // realpath then canonicalizes intermediate symlinks too; the canonical path
    // is what we containment-check, so any escape resolves to its true location.
    let real: string;
    try {
      await lstat(absolute);
      real = await realpath(absolute);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new ConfigError(`Path does not exist: ${absolute}`, {
          path: absolute,
          allowedRoots: this.roots,
        });
      }
      throw new ConfigError(`Cannot access path: ${absolute}`, {
        path: absolute,
        allowedRoots: this.roots,
      });
    }

    const canonicalRoots = await this.canonicalRoots();
    if (!canonicalRoots.some((root) => isWithinRoot(real, root))) {
      throw new ConfigError(
        `Path is outside the allowed roots: ${absolute}. ` +
          `Allowed roots: ${this.roots.join(", ")}.`,
        { path: absolute, resolved: real, allowedRoots: this.roots },
      );
    }

    return real;
  }

  /** Canonicalize each configured root; a missing root falls back to its absolute form. */
  private async canonicalRoots(): Promise<readonly string[]> {
    return Promise.all(
      this.roots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return root;
        }
      }),
    );
  }
}

/**
 * Return true when `target` equals, or is nested under, `root`. Uses
 * {@link relative} so a sibling like `/foo-bar` is not treated as inside `/foo`.
 */
function isWithinRoot(target: string, root: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}
