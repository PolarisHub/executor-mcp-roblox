import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsSessionLogger } from "../../src/infrastructure/sessions/fs-session-logger.js";
import type { SessionTraceRecord } from "../../src/application/ports/session-logger.js";

const baseRecord = (overrides: Partial<SessionTraceRecord> = {}): SessionTraceRecord => ({
  seq: 1,
  at: Date.now(),
  tool: "get-players",
  input: {},
  elapsedMs: 5,
  sessionId: "abcdef01-2345-6789-abcd-ef0123456789",
  result: { players: [] },
  ...overrides,
});

describe("FsSessionLogger", () => {
  let dir: string;
  let logger: FsSessionLogger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "exec-mcp-sess-"));
    logger = new FsSessionLogger(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends records and reads them back in seq order", async () => {
    logger.append(baseRecord({ seq: 1, tool: "list-clients" }), "live");
    logger.append(baseRecord({ seq: 2, tool: "get-players" }), "live");
    logger.append(baseRecord({ seq: 3, tool: "execute" }), "live");

    const all = await logger.read("abcdef01-2345-6789-abcd-ef0123456789");
    expect(all.map((r) => r.tool)).toEqual(["list-clients", "get-players", "execute"]);
    expect(all.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("respects from/to window when reading", async () => {
    for (let i = 1; i <= 5; i++) logger.append(baseRecord({ seq: i, tool: `t${i}` }), "live");
    const slice = await logger.read("abcdef01-2345-6789-abcd-ef0123456789", { from: 2, to: 4 });
    expect(slice.map((r) => r.seq)).toEqual([2, 3, 4]);
  });

  it("list() returns sessions with label, count, bytes, newest-first", async () => {
    const sidA = "aaaaaaaa-1111-1111-1111-111111111111";
    const sidB = "bbbbbbbb-2222-2222-2222-222222222222";
    logger.append(baseRecord({ seq: 1, sessionId: sidA, at: 1000 }), "alpha");
    logger.append(baseRecord({ seq: 2, sessionId: sidA, at: 2000 }), "alpha");
    logger.append(baseRecord({ seq: 1, sessionId: sidB, at: 5000 }), "beta");

    const sessions = await logger.list();
    expect(sessions).toHaveLength(2);
    // Newest first by startedAt (first record's `at`)
    expect(sessions[0]!.sessionId).toBe(sidB);
    expect(sessions[1]!.sessionId).toBe(sidA);
    expect(sessions[0]!.sessionLabel).toBe("beta");
    expect(sessions[1]!.count).toBe(2);
    expect(sessions[0]!.bytes).toBeGreaterThan(0);
  });

  it("a write failure inside append() never throws", () => {
    // Use a non-existent dir buried inside a forbidden read-only path; on most
    // platforms this would normally throw, but append swallows. We simulate by
    // pointing logger at a path that doesn't exist and was never created.
    const broken = new FsSessionLogger(join(dir, "this", "path", "is", "fine"));
    expect(() => broken.append(baseRecord(), "label")).not.toThrow();
  });
});
