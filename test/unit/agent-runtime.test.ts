import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inferToolContract } from "../../src/application/tool/tool-contract.js";
import type { ToolContext, ToolResult } from "../../src/application/tool/tool.js";
import type { ToolDescriptor, ToolDirectory } from "../../src/application/ports/tool-directory.js";
import agentRun from "../../src/tools/utility/agent-run.js";
import agentMemory from "../../src/tools/utility/agent-memory.js";

function directory(): ToolDirectory {
  const tools: ToolDescriptor[] = [
    {
      name: "get-data",
      title: "Get data",
      description: "Read a path.",
      category: "Inspection",
      mutatesState: false,
      requiresClient: false,
      input: z.object({}),
    },
    {
      name: "set-value",
      title: "Set value",
      description: "Write a path.",
      category: "Actions",
      mutatesState: true,
      requiresClient: false,
      ai: {
        ...inferToolContract({
          name: "set-instance-property",
          category: "Actions",
          mutatesState: true,
          requiresClient: false,
        }),
        verifiesWith: ["verify-value"],
      },
      input: z.object({ path: z.string(), value: z.unknown() }),
    },
    {
      name: "verify-value",
      title: "Verify value",
      description: "Read a written value.",
      category: "Inspection",
      mutatesState: false,
      requiresClient: false,
      input: z.object({ path: z.string() }),
    },
  ];
  return { list: () => tools, find: (name) => tools.find((tool) => tool.name === name) ?? null };
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { tools: directory(), ...overrides } as unknown as ToolContext;
}

describe("agent runtime", () => {
  it("infers contracts for legacy tools", () => {
    const contract = inferToolContract({
      name: "click-button",
      category: "GUI",
      mutatesState: true,
      requiresClient: true,
    });
    expect(contract.phase).toBe("act");
    expect(contract.prerequisites).toContain("active-client");
    expect(contract.requiresCapabilities).toContain("firesignal");
    expect(contract.alternatives).toContain("virtual-input");
  });

  it("resolves references, executes steps, and verifies mutations", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const invokeTool = async (name: string, input: unknown): Promise<ToolResult> => {
      calls.push({ name, input });
      if (name === "get-data") return { data: { path: "game.Workspace.Cash" } };
      return { data: { ok: true } };
    };
    const result = await agentRun.execute(
      {
        goal: "read then update and verify a value",
        steps: [
          { id: "read", tool: "get-data", input: {}, retries: 0 },
          {
            id: "write",
            tool: "set-value",
            input: { path: "$steps.read.data.path", value: 100 },
            verifyWith: "verify-value",
            verifyInput: { path: "$steps.read.data.path" },
            retries: 0,
          },
        ],
        dryRun: false,
        allowMutations: true,
        retryMutations: false,
        verify: true,
        stopOnError: true,
        maxSteps: 20,
      },
      context({ invokeTool }),
    );
    const data = result.data as {
      status: string;
      results: Array<{ status: string; verification?: { status: string } }>;
    };
    expect(data.status).toBe("completed");
    expect(calls).toEqual([
      { name: "get-data", input: {} },
      { name: "set-value", input: { path: "game.Workspace.Cash", value: 100 } },
      { name: "verify-value", input: { path: "game.Workspace.Cash" } },
    ]);
    expect(data.results[1]?.verification?.status).toBe("ok");
  });

  it("blocks mutations in dry-run mode without invoking tools", async () => {
    const invokeTool = async (): Promise<ToolResult> => ({ data: { unexpected: true } });
    const result = await agentRun.execute(
      {
        goal: "write a value",
        steps: [{ id: "write", tool: "set-value", input: { path: "x", value: 1 }, retries: 0 }],
        dryRun: true,
        allowMutations: false,
        retryMutations: false,
        verify: true,
        stopOnError: true,
        maxSteps: 20,
      },
      context({ invokeTool }),
    );
    const data = result.data as { status: string; plan: Array<{ blocked: boolean }> };
    expect(data.status).toBe("dry-run");
    expect(data.plan[0]?.blocked).toBe(true);
  });

  it("persists and recalls episodic memory through the playbook store", async () => {
    const records = new Map<string, { name: string; source: string; tags?: readonly string[] }>();
    const playbooks = {
      save: async (record: { name: string; source: string; tags?: readonly string[] }) => {
        records.set(record.name, record);
        return record;
      },
      list: async (filter?: { tag?: string }) =>
        [...records.values()].filter((record) => !filter?.tag || record.tags?.includes(filter.tag)),
      delete: async (name: string) => records.delete(name),
      get: async (name: string) => records.get(name) ?? null,
    };
    const base = context({
      playbooks,
      session: {
        id: "session-test" as never,
        label: "Test",
        selection: {},
        select: () => undefined,
        clear: () => undefined,
        resolve: () => ({ status: "none", reason: "no-clients" }),
      },
      sessionLogger: { read: async () => [], list: async () => [], append: () => undefined },
    });
    await agentMemory.execute(
      { operation: "remember", key: "shop-path", text: "Shop button is in Main.Shop", limit: 10 },
      base,
    );
    const result = await agentMemory.execute(
      { operation: "recall", query: "shop", limit: 10 },
      base,
    );
    const data = result.data as { count: number; memories: Array<{ key: string }> };
    expect(data.count).toBe(1);
    expect(data.memories[0]?.key).toBe("shop-path");
  });
});
