export interface PreflightFinding {
  /** The tool name as it would be invoked on the server (kebab-case). */
  readonly name: string;
  /** How the AI wrote it in source (e.g. "getPlayers" or "get-players"). */
  readonly written: string;
  /** Times this exact identifier appears in the source. */
  readonly occurrences: number;
  /** Best alternative tool names by edit distance, when the call is unknown. */
  readonly suggestions: readonly string[];
}

export interface PreflightReport {
  readonly errors: readonly PreflightFinding[];
  readonly callCount: number;
}

const CAMEL_TO_KEBAB = /[A-Z]/g;
function camelToKebab(s: string): string {
  if (s.includes("-")) return s;
  return s.replace(CAMEL_TO_KEBAB, (m, i: number) => (i === 0 ? m.toLowerCase() : "-" + m.toLowerCase()));
}

// `mcp.X(`, `mcp.X{`, `mcp.X "..."` are all valid Luau invocation forms; only
// the parenthesized form is unambiguous, so that's what we flag.
const DOT_RE = /\bmcp\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
// `mcp.call("kebab-name", ...)` is the explicit string form.
const CALL_RE = /\bmcp\.call\s*\(\s*["']([a-zA-Z_][a-zA-Z0-9_-]*)["']/g;

/** Levenshtein with a small cap so very-different strings exit early. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

function suggest(name: string, candidates: readonly string[], limit = 3): string[] {
  const cap = Math.max(2, Math.floor(name.length / 2));
  const scored: { name: string; d: number }[] = [];
  for (const c of candidates) {
    const d = distance(name, c, cap);
    if (d <= cap) scored.push({ name: c, d });
  }
  scored.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

/**
 * Scan a script's Luau source for `mcp.<name>(` and `mcp.call("kebab")` calls.
 * Returns a list of statically-detectable unknown tools with edit-distance
 * suggestions. Dynamic lookups (`mcp[name]`) are intentionally not scanned —
 * we only flag what the AI almost certainly meant statically.
 */
export function preflightScript(source: string, knownTools: readonly string[]): PreflightReport {
  const knownSet = new Set(knownTools);
  const knownNames = [...knownSet];
  const errors = new Map<string, PreflightFinding>();
  let callCount = 0;

  let m: RegExpExecArray | null;
  DOT_RE.lastIndex = 0;
  while ((m = DOT_RE.exec(source)) !== null) {
    const written = m[1]!;
    // `mcp.call(...)` is the proxy; the CALL regex below counts and validates it.
    if (written === "call") continue;
    callCount += 1;
    const name = camelToKebab(written);
    if (knownSet.has(name)) continue;
    const key = `dot:${name}`;
    const prev = errors.get(key);
    errors.set(key, prev
      ? { ...prev, occurrences: prev.occurrences + 1 }
      : { name, written, occurrences: 1, suggestions: suggest(name, knownNames) });
  }

  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(source)) !== null) {
    callCount += 1;
    const name = m[1]!.toLowerCase();
    if (knownSet.has(name)) continue;
    const key = `call:${name}`;
    const prev = errors.get(key);
    errors.set(key, prev
      ? { ...prev, occurrences: prev.occurrences + 1 }
      : { name, written: name, occurrences: 1, suggestions: suggest(name, knownNames) });
  }

  return { errors: [...errors.values()], callCount };
}
