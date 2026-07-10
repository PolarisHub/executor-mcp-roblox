import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import stateTransaction from "../../../src/tools/intelligence/state-transaction.js";

interface CapturedCall {
  readonly source: string;
  readonly options?: LuauOptions;
}

function stubContext(canned: unknown): {
  readonly ctx: ToolContext;
  readonly calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const ctx = {
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return canned;
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("state-transaction", () => {
  it("declares mutation safety, bounded-journal semantics, and a useful AI contract", () => {
    expect(stateTransaction.name).toBe("state-transaction");
    expect(stateTransaction.category).toBe("Intelligence");
    expect(stateTransaction.mutatesState).toBe(true);
    expect(stateTransaction.description).toContain("reverse journal order");
    expect(stateTransaction.description).toContain("not a general undo system");
    expect(stateTransaction.description).toContain("destroyed Instances");
    expect(stateTransaction.description).toContain("Commit intentionally discards");
    expect(stateTransaction.ai).toMatchObject({
      phase: "act",
      requiresCapabilities: ["getgenv"],
      verifiesWith: [],
    });
    expect(stateTransaction.ai?.sideEffects.join(" ")).toContain(
      "connection disconnect cleanup is irreversible",
    );
    expect(stateTransaction.ai?.failureRecovery.join(" ")).toContain("never assume destroyed");
  });

  it("validates lifecycle actions and enforces hard schema caps", () => {
    const parsed = stateTransaction.input.parse({ action: "begin" });
    expect(parsed).toMatchObject({
      action: "begin",
      targets: [],
      captureCamera: false,
      cleanupItems: [],
      limit: 16,
      cleanupMode: "rollback",
      includeOrphans: true,
    });
    expect(stateTransaction.input.safeParse({ action: "unknown" }).success).toBe(false);
    expect(stateTransaction.input.safeParse({ action: "begin", maxItems: 257 }).success).toBe(
      false,
    );
    expect(
      stateTransaction.input.safeParse({ action: "begin", expirySeconds: 86_401 }).success,
    ).toBe(false);
    expect(stateTransaction.input.safeParse({ action: "cleanup", limit: 33 }).success).toBe(false);
  });

  it("generates begin/capture Luau for explicit fields, camera, and every cleanup resource", async () => {
    const canned = {
      status: "active",
      transactionId: "tx-safe",
      capture: { captured: 10, failed: 0, unsupported: 0 },
    };
    const { ctx, calls } = stubContext(canned);
    const input = stateTransaction.input.parse({
      action: "begin",
      transactionId: "tx-safe",
      name: "shop test",
      targets: [
        {
          path: "game.Workspace.Door",
          properties: ["CFrame", "Transparency"],
          attributes: ["Locked"],
        },
      ],
      captureCamera: true,
      cleanupItems: [
        { kind: "drawing", id: 7 },
        { kind: "virtual-input", inputType: "key", key: "W" },
        {
          kind: "connection",
          expression: "getgenv().temporaryConnection",
          rollbackAction: "restore-state",
        },
        { kind: "hook", key: "game.Workspace.Door.Open" },
      ],
      maxItems: 80,
      expirySeconds: 120,
      threadContext: 9,
    });

    const result = await stateTransaction.execute(input, ctx);

    expect(result.data).toBe(canned);
    expect(result.summary).toContain("tx-safe");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ threadContext: 9, timeoutMs: 30000 });
    const source = calls[0]?.source ?? "";
    expect(source).toContain('local ACTION = "begin"');
    expect(source).toContain('local REQUESTED_ID = "tx-safe"');
    expect(source).toContain('path = "game.Workspace.Door"');
    expect(source).toContain('properties = { "CFrame", "Transparency" }');
    expect(source).toContain('attributes = { "Locked" }');
    expect(source).toContain("instance[property]");
    expect(source).toContain("instance:GetAttribute(attribute)");
    expect(source).toContain(
      'local cameraFields = { "CameraType", "CameraSubject", "CFrame", "Focus", "FieldOfView" }',
    );
    expect(source).toContain("genv.__mcp_drawings");
    expect(source).toContain('inputType = "key"');
    expect(source).toContain('expression = "getgenv().temporaryConnection"');
    expect(source).toContain("genv.__mcp_hooks");
    expect(source).toContain("genv.__mcp_hook_meta");
    expect(source).toContain("pcall(newcclosure, fn)");
  });

  it("uses a versioned bounded getgenv registry and refuses unknown/corrupt state", async () => {
    const { ctx, calls } = stubContext({ status: "active", transactionId: "tx-1" });
    await stateTransaction.execute(stateTransaction.input.parse({ action: "begin" }), ctx);
    const source = calls[0]?.source ?? "";

    expect(source).toContain('local REGISTRY_KEY = "__mcp_state_transactions"');
    expect(source).toContain("version = 1, counter = 0, transactions = {}");
    expect(source).toContain("MAX_TRANSACTIONS = 32");
    expect(source).toContain("HARD_MAX_ITEMS = 256");
    expect(source).toContain("DEFAULT_MAX_ITEMS = 128");
    expect(source).toContain("DEFAULT_EXPIRY = 900");
    expect(source).toContain("refusing to overwrite unknown state");
    expect(source).toContain("Transaction registry is full");
    expect(source).toContain("already exists; refusing to overwrite snapshots");
  });

  it("rolls back strictly in reverse order with isolated and classified per-item results", async () => {
    const canned = {
      status: "rollback-incomplete",
      transactionId: "tx-rb",
      restored: 3,
      cleaned: 2,
      failed: 1,
      unsupported: 1,
    };
    const { ctx, calls } = stubContext(canned);
    const result = await stateTransaction.execute(
      stateTransaction.input.parse({ action: "rollback", transactionId: "tx-rb" }),
      ctx,
    );
    const source = calls[0]?.source ?? "";

    expect(source).toContain('local ACTION = "rollback"');
    expect(source).toContain("for index = #items, 1, -1 do");
    expect(source).toContain("pcall(restoreItem, items[index], index)");
    expect(source).toContain('result.status == "restored"');
    expect(source).toContain('result.status == "cleaned"');
    expect(source).toContain('result.status == "unsupported"');
    expect(source).toContain("item.instance[item.property] = item.value");
    expect(source).toContain("item.instance:SetAttribute");
    expect(source).toContain("item.camera[item.cameraProperty] = item.value");
    expect(source).toContain("item.connection:Disconnect()");
    expect(source).toContain("disconnected connections cannot be recreated");
    expect(source).toContain("restorefunction");
    expect(source).toContain("hookmetamethod");
    expect(result.isError).toBe(true);
    expect(result.summary).toContain("3 restored, 2 cleaned, 1 failed, 1 unsupported");
  });

  it("commits by discarding the journal and explicitly reports that no restoration ran", async () => {
    const canned = {
      status: "committed",
      transactionId: "tx-commit",
      discardedItems: 6,
      restorationAttempted: false,
    };
    const { ctx, calls } = stubContext(canned);
    const result = await stateTransaction.execute(
      stateTransaction.input.parse({ action: "commit", name: "unique transaction" }),
      ctx,
    );
    const source = calls[0]?.source ?? "";

    expect(source).toContain('local ACTION = "commit"');
    expect(source).toContain("registry.transactions[id] = nil");
    expect(source).toContain("restorationAttempted = false");
    expect(source).toContain("Commit discarded snapshots and cleanup registrations");
    expect(result.summary).toContain("6 journal item(s) were discarded without restoration");
  });

  it("cleanup detects expiry and cross-place/job orphaning with bounded rollback work", async () => {
    const canned = {
      status: "cleanup-complete",
      processed: 2,
      remaining: 1,
      results: [],
    };
    const { ctx, calls } = stubContext(canned);
    const result = await stateTransaction.execute(
      stateTransaction.input.parse({
        action: "cleanup",
        cleanupMode: "rollback",
        includeOrphans: true,
        limit: 4,
      }),
      ctx,
    );
    const source = calls[0]?.source ?? "";

    expect(source).toContain('local ACTION = "cleanup"');
    expect(source).toContain('local CLEANUP_MODE = "rollback"');
    expect(source).toContain("tx.ownerPlaceId ~= placeId");
    expect(source).toContain("tx.ownerJobId ~= jobId");
    expect(source).toContain("tx.expiresAt <= timestamp");
    expect(source).toContain("MAX_CLEANUP_WORK = 512");
    expect(source).toContain("work + itemCount > MAX_CLEANUP_WORK");
    expect(source).toContain('status = "discarded"');
    expect(result.summary).toContain("processed 2 expired/orphaned transaction(s); 1 remain");
  });

  it("rejects ambiguous lifecycle calls and malformed held-input cleanup before execution", async () => {
    const { ctx, calls } = stubContext({});

    const missingRef = await stateTransaction.execute(
      stateTransaction.input.parse({ action: "rollback" }),
      ctx,
    );
    expect(missingRef.isError).toBe(true);
    expect(missingRef.summary).toContain("requires transactionId or a unique name");

    const missingKey = await stateTransaction.execute(
      stateTransaction.input.parse({
        action: "begin",
        cleanupItems: [{ kind: "virtual-input", inputType: "key" }],
      }),
      ctx,
    );
    expect(missingKey.isError).toBe(true);
    expect(missingKey.summary).toContain("key cleanup requires key");
    expect(calls).toHaveLength(0);
  });

  it("rejects a capture whose aggregate request exceeds the hard item bound", async () => {
    const { ctx, calls } = stubContext({});
    const fields = Array.from({ length: 32 }, (_, index) => `Field${index}`);
    const targets = Array.from({ length: 4 }, (_, index) => ({
      path: `game.Workspace.Target${index}`,
      properties: fields,
      attributes: fields,
    }));
    const result = await stateTransaction.execute(
      stateTransaction.input.parse({
        action: "begin",
        targets,
        captureCamera: true,
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ requestedItems: 261, maxItems: 256 });
    expect(result.summary).toContain("256-item safety cap");
    expect(calls).toHaveLength(0);
  });
});
