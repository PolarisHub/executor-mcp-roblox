import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import type {
  EvalRequest,
  ExecutionGateway,
} from "../../../src/application/ports/execution-gateway.js";
import { ClientNotFoundError } from "../../../src/domain/errors/errors.js";
import type { ClientId } from "../../../src/domain/shared/ids.js";
import {
  ExplorerService,
  functionReferencesLuau,
  scriptInspectionLuau,
} from "../../../src/infrastructure/dashboard/dashboard-explorer.js";
import { renderDashboardPage } from "../../../src/infrastructure/dashboard/page.js";
import { InMemoryClientDirectory, makeClient } from "../../helpers/fakes.js";

function recordingGateway(): ExecutionGateway & {
  calls: Array<{ clientId: ClientId; request: EvalRequest }>;
} {
  const calls: Array<{ clientId: ClientId; request: EvalRequest }> = [];
  return {
    calls,
    async eval(clientId, request) {
      calls.push({ clientId, request });
      return { ok: true };
    },
  };
}

describe("dashboard Explorer script analysis", () => {
  it("builds bounded decompile and proto metadata Luau", () => {
    const source = scriptInspectionLuau('game["ReplicatedStorage"]["Main"]');

    expect(source).toContain("local MAX_SOURCE_CHARS = 350000");
    expect(source).toContain("local MAX_SOURCE_LINES = 6000");
    expect(source).toContain("local MAX_FUNCTIONS = 320");
    expect(source).toContain("local MAX_DEPTH = 10");
    expect(source).toContain("pcall(decompile, scriptInstance)");
    expect(source).toContain("__getscriptclosure");
    expect(source).toContain("directProtoCount = #protos");
    expect(source).toContain("descendantProtoCount");
    expect(source).toContain("functionRefs = functionRefs");
    expect(source).toContain("originExpression = info.originExpression");
    expect(source).not.toContain("GetDescendants(");
  });

  it("builds an on-demand, yielding, time-bounded reference scan", () => {
    const source = functionReferencesLuau("game.Workspace.Main", "1.2", 3500);

    expect(source).toContain('local functionId = "1.2"');
    expect(source).toContain("local MAX_SCANNED = 3500");
    expect(source).toContain("local MAX_RESULTS = 80");
    expect(source).toContain("local MAX_SECONDS = 2.5");
    expect(source).toContain("pcall(getgc, false)");
    expect(source).toContain("task.wait()");
    expect(source).toContain('addRef(candidate, "upvalue", slot)');
    expect(source).toContain('addRef(candidate, "proto", index)');
    expect(source).toContain("if indexed >= 1200 then break end");
  });

  it("uses longer script deadlines, clamps scans, and rejects stale function ids locally", async () => {
    const client = makeClient();
    const gateway = recordingGateway();
    const service = new ExplorerService(gateway, new InMemoryClientDirectory([client]));

    await service.script(client.id, "game.Workspace.Main");
    expect(gateway.calls[0]?.request).toMatchObject({ threadContext: 8, timeoutMs: 60000 });

    await service.references(client.id, "game.Workspace.Main", "root", { maxScanned: 50_000 });
    expect(gateway.calls[1]?.request.source).toContain("local MAX_SCANNED = 8000");
    expect(gateway.calls[1]?.request.timeoutMs).toBe(30000);

    const invalid = await service.references(client.id, "game.Workspace.Main", "root; print(1)");
    expect(invalid).toEqual({
      error: "Invalid function id; refresh the script tab and try again.",
    });
    expect(gateway.calls).toHaveLength(2);

    await expect(service.script("missing", "game.Workspace.Main")).rejects.toBeInstanceOf(
      ClientNotFoundError,
    );
  });

  it("renders double-click tabs, exact line jumps, function details, and reference navigation", () => {
    const page = renderDashboardPage();

    expect(page).toContain("tree.ondblclick = function");
    expect(page).toContain('title="Double-click to decompile"');
    expect(page).toContain("/api/explore/script?");
    expect(page).toContain("/api/explore/references?");
    expect(page).toContain('aria-label="Explorer workspace tabs"');
    expect(page).toContain("Function tree");
    expect(page).toContain("Function upvalue references");
    expect(page).toContain("Find references");
    expect(page).toContain('scrollIntoView({ block: "center", inline: "nearest" })');

    const embeddedScript = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1];
    expect(embeddedScript).toBeDefined();
    expect(() => new Script(embeddedScript ?? "}")).not.toThrow();
  });
});
