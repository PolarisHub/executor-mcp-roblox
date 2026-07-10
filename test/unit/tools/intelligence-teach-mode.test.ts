import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext, ToolResult } from "../../../src/application/tool/tool.js";
import teachMode from "../../../src/tools/intelligence/teach-mode.js";

interface LuauCall {
  readonly source: string;
  readonly options?: LuauOptions;
}

interface InvokeCall {
  readonly name: string;
  readonly input: unknown;
}

function stubContext(options: {
  readonly luauResult: unknown;
  readonly availableTools?: readonly string[];
  readonly invoke?: (name: string, input: unknown) => Promise<ToolResult>;
}): { ctx: ToolContext; luauCalls: LuauCall[]; invokeCalls: InvokeCall[] } {
  const luauCalls: LuauCall[] = [];
  const invokeCalls: InvokeCall[] = [];
  const available = new Set(options.availableTools ?? []);
  const ctx = {
    async runLuau(source: string, runOptions?: LuauOptions) {
      luauCalls.push({ source, options: runOptions });
      return options.luauResult;
    },
    tools: {
      list() {
        return [];
      },
      find(name: string) {
        return available.has(name) ? ({ name } as never) : null;
      },
    },
    async invokeTool(name: string, input: unknown) {
      invokeCalls.push({ name, input });
      return options.invoke ? options.invoke(name, input) : { data: {} };
    },
  } as unknown as ToolContext;
  return { ctx, luauCalls, invokeCalls };
}

describe("teach-mode", () => {
  it("exposes orchestration metadata and bounded defaults", () => {
    expect(teachMode.name).toBe("teach-mode");
    expect(teachMode.category).toBe("Intelligence");
    expect(teachMode.mutatesState).toBe(true);
    expect(teachMode.ai?.phase).toBe("orchestrate");
    expect(teachMode.ai?.produces).toContain("Bounded chronological event timeline");
    expect(teachMode.ai?.failureRecovery.join(" ")).toContain("action=cancel");

    const parsed = teachMode.input.parse({ action: "start" });
    expect(parsed).toMatchObject({
      maxEvents: 1000,
      movementThrottleMs: 100,
      expirySeconds: 600,
      maxGuiWatch: 350,
      includeRemoteSpy: false,
      remoteLimit: 250,
    });
    expect(() => teachMode.input.parse({ action: "start", maxEvents: 5001 })).toThrow();
  });

  it("starts an event-driven bounded recorder with all required observation surfaces", async () => {
    const { ctx, luauCalls } = stubContext({
      luauResult: { ok: true, action: "start", sessionId: "demo", active: true },
    });
    const input = teachMode.input.parse({
      action: "start",
      sessionId: "demo",
      maxEvents: 120,
      movementThrottleMs: 75,
      expirySeconds: 90,
      maxGuiWatch: 80,
    });

    const result = await teachMode.execute(input, ctx);

    expect(result.isError).not.toBe(true);
    expect(result.summary).toContain("Teach-mode is recording");
    const data = result.data as Record<string, unknown>;
    expect(data["remoteSpyIntegration"]).toMatchObject({
      requested: false,
      enabled: false,
      status: "disabled",
    });
    expect(luauCalls).toHaveLength(1);
    const { source, options } = luauCalls[0]!;
    expect(options).toEqual({ threadContext: undefined, timeoutMs: 30000 });
    expect(source).toContain("maxEvents = 120");
    expect(source).toContain("movementThrottleSeconds = 75 / 1000");
    expect(source).toContain("buffer = {}");
    expect(source).toContain("index = ((session.head + session.size - 1) % session.maxEvents) + 1");
    expect(source).not.toContain(
      "index = ((session.head + session.size - 2) % session.maxEvents) + 1",
    );
    expect(source).toContain("session.head = (session.head % session.maxEvents) + 1");
    expect(source).toContain("UserInputService.InputBegan");
    expect(source).toContain("UserInputService.InputChanged");
    expect(source).toContain("instance.Activated");
    expect(source).toContain("ProximityPromptService.PromptTriggered");
    expect(source).toContain("local scanned, scanCap = 0, session.maxGuiWatch * 4");
    expect(source).not.toContain("playerGui:GetDescendants()");
    expect(source).toContain("localPlayer.CharacterAdded");
    expect(source).toContain('kind = "tool_equipped"');
    expect(source).toContain("task.delay");
    expect(source).toContain('disconnectSession(session, "expired", true)');
    expect(source).toContain("connection:Disconnect()");
  });

  it("enables optional remote capture through the nested tool invoker", async () => {
    const { ctx, luauCalls, invokeCalls } = stubContext({
      luauResult: { ok: true, action: "start", sessionId: "remote-demo", active: true },
      availableTools: ["trace-remote-traffic"],
      async invoke() {
        return { data: { started: true, max: 500 } };
      },
    });
    const input = teachMode.input.parse({
      action: "start",
      sessionId: "remote-demo",
      includeRemoteSpy: true,
      remoteLimit: 77,
      threadContext: 4,
    });

    const result = await teachMode.execute(input, ctx);

    expect(invokeCalls).toEqual([
      {
        name: "trace-remote-traffic",
        input: { action: "start", limit: 77, threadContext: 4 },
      },
    ]);
    expect(luauCalls[0]?.source).toContain("remoteSpyEnabled = true");
    expect(luauCalls[0]?.source).toContain("remoteSpyOwned = true");
    expect((result.data as Record<string, unknown>)["remoteSpyIntegration"]).toMatchObject({
      enabled: true,
      owned: true,
      status: "started",
    });
  });

  it("polls by cursor and merges filtered remote events chronologically", async () => {
    const { ctx, luauCalls, invokeCalls } = stubContext({
      luauResult: {
        ok: true,
        action: "poll",
        sessionId: "demo",
        active: true,
        startedAt: 100,
        remoteSpyEnabled: true,
        remoteSpyOwned: true,
        events: [{ seq: 7, t: 2.5, kind: "input_began", inputType: "Keyboard", keyCode: "E" }],
      },
      availableTools: ["trace-remote-traffic"],
      async invoke(_name, input) {
        expect(input).toMatchObject({ action: "fetch", limit: 25, threadContext: 8 });
        return {
          data: {
            entries: [
              { t: 104, remote: "ReplicatedStorage.Remotes.Buy", method: "FireServer" },
              { t: 101, remote: "ReplicatedStorage.Remotes.Old", method: "FireServer" },
            ],
          },
        };
      },
    });
    const input = teachMode.input.parse({
      action: "poll",
      sessionId: "demo",
      sinceSeq: 6,
      limit: 10,
      remoteLimit: 25,
      sinceRemoteTime: 1.5,
      threadContext: 8,
    });

    const result = await teachMode.execute(input, ctx);

    expect(luauCalls[0]?.options?.timeoutMs).toBe(15000);
    expect(luauCalls[0]?.source).toContain("snapshot(6, 10)");
    expect(invokeCalls).toHaveLength(1);
    const data = result.data as { events: Array<Record<string, unknown>> };
    expect(data.events).toHaveLength(2);
    expect(data.events.map((event) => event["kind"])).toEqual(["input_began", "remote_call"]);
    expect(data.events[1]).toMatchObject({
      t: 4,
      remoteId: "remote:104:FireServer:ReplicatedStorage.Remotes.Buy",
    });
  });

  it("stops, disconnects, and generates semantic guarded action candidates without duplicating a GUI click", async () => {
    const button = {
      name: "Play",
      className: "TextButton",
      path: "Players.User.PlayerGui.Main.Play",
      expression:
        'game:GetService("Players"):FindFirstChild("User"):FindFirstChild("PlayerGui"):FindFirstChild("Main"):FindFirstChild("Play")',
      text: "Play",
    };
    const prompt = {
      name: "Open",
      className: "ProximityPrompt",
      path: "Workspace.Door.Open",
      expression: 'game:GetService("Workspace"):FindFirstChild("Door"):FindFirstChild("Open")',
    };
    const { ctx, luauCalls } = stubContext({
      luauResult: {
        ok: true,
        action: "stop",
        sessionId: "demo",
        startedAt: 10,
        remoteSpyEnabled: false,
        remoteSpyOwned: false,
        dropped: 0,
        connectionsDisconnected: 42,
        stats: { kindCounts: {} },
        events: [
          { seq: 1, t: 0.1, kind: "character_ready", target: { name: "User", className: "Model" } },
          { seq: 2, t: 0.2, kind: "gui_appeared", target: button },
          {
            seq: 3,
            t: 0.8,
            kind: "input_began",
            inputId: 1,
            inputType: "MouseButton1",
            x: 50,
            y: 70,
          },
          { seq: 4, t: 0.85, kind: "gui_activated", target: button },
          {
            seq: 5,
            t: 0.9,
            kind: "input_ended",
            inputId: 1,
            inputType: "MouseButton1",
            x: 50,
            y: 70,
          },
          { seq: 6, t: 2, kind: "proximity_triggered", target: prompt },
          { seq: 7, t: 3, kind: "input_began", inputId: 2, inputType: "Keyboard", keyCode: "E" },
          { seq: 8, t: 3.2, kind: "input_ended", inputId: 2, inputType: "Keyboard", keyCode: "E" },
        ],
      },
    });
    const input = teachMode.input.parse({ action: "stop", sessionId: "demo" });

    const result = await teachMode.execute(input, ctx);

    expect(luauCalls[0]?.options?.timeoutMs).toBe(20000);
    expect(luauCalls[0]?.source).toContain("connection:Disconnect()");
    expect(luauCalls[0]?.source).toContain("state.sessions[sessionId] = nil");
    const playbook = (result.data as { playbook: Record<string, unknown> }).playbook;
    expect(playbook).toMatchObject({
      kind: "teach-mode-conservative-draft",
      autoExecutable: false,
      manualReviewRequired: true,
    });
    const steps = playbook["steps"] as Array<Record<string, unknown>>;
    const tools = steps.map((step) => (step["candidate"] as Record<string, unknown>)["tool"]);
    expect(tools).toEqual(["click-button", "fire-proximity-prompt", "virtual-input"]);
    expect(tools.filter((tool) => tool === "virtual-input")).toHaveLength(1);
    const clickGuards = steps[0]?.["guards"] as Array<Record<string, unknown>>;
    expect(clickGuards.map((guard) => guard["type"])).toEqual(
      expect.arrayContaining(["target-exists", "target-visible", "character-ready"]),
    );
    const sourceDraft = playbook["sourceDraft"] as string;
    expect(sourceDraft).toContain('mcp.call("click-button"');
    expect(sourceDraft).toContain('mcp.call("fire-proximity-prompt"');
    expect(sourceDraft).toContain('mcp.call("virtual-input"');
    expect(sourceDraft).toContain("[=[${button_path_1}]=]");
    expect(sourceDraft).toContain("REVIEW REQUIRED");
  });

  it("marks remote replay high-risk, omits it from executable source, and releases an owned hook", async () => {
    const invokeActions: string[] = [];
    const { ctx } = stubContext({
      luauResult: {
        ok: true,
        action: "stop",
        sessionId: "remote-demo",
        startedAt: 50,
        remoteSpyEnabled: true,
        remoteSpyOwned: true,
        events: [],
        dropped: 0,
        stats: {},
      },
      availableTools: ["trace-remote-traffic"],
      async invoke(_name, input) {
        const action = (input as { action: string }).action;
        invokeActions.push(action);
        if (action === "fetch") {
          return {
            data: {
              entries: [
                {
                  t: 51,
                  remote: "ReplicatedStorage.Remotes.Buy",
                  method: "FireServer",
                  args: ["Sword", { __type: "Instance", path: "Workspace.Shop" }],
                  argCount: 4,
                  argsTruncated: true,
                },
              ],
            },
          };
        }
        return { data: { stopped: true, restored: true } };
      },
    });

    const result = await teachMode.execute(
      teachMode.input.parse({ action: "stop", sessionId: "remote-demo" }),
      ctx,
    );

    expect(invokeActions).toEqual(["fetch", "stop"]);
    const playbook = (result.data as { playbook: Record<string, unknown> }).playbook;
    const steps = playbook["steps"] as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    expect(steps[0]?.["candidate"]).toMatchObject({ tool: "fire-remote" });
    expect(steps[0]?.["confidence"]).toBe("low");
    expect(playbook["uncertainty"]).toMatchObject({ overall: "high" });
    expect(playbook["manualReviewFlags"]).toEqual(
      expect.arrayContaining([expect.stringContaining("argument list was truncated")]),
    );
    const sourceDraft = playbook["sourceDraft"] as string;
    expect(sourceDraft).toContain("OMITTED step-1: fire-remote");
    expect(sourceDraft).not.toContain('mcp.call("fire-remote"');
    expect((result.data as Record<string, unknown>)["remoteSpyCleanup"]).toMatchObject({
      released: true,
      method: "invokeTool",
    });
  });

  it("cancels by disconnecting and discarding without generating a playbook", async () => {
    const { ctx, luauCalls } = stubContext({
      luauResult: {
        ok: true,
        action: "cancel",
        sessionId: "demo",
        cancelled: true,
        discarded: 19,
        connectionsDisconnected: 12,
        remoteSpyOwned: false,
      },
    });

    const result = await teachMode.execute(
      teachMode.input.parse({ action: "cancel", sessionId: "demo" }),
      ctx,
    );

    expect(luauCalls[0]?.source).toContain('action == "cancel"');
    expect(luauCalls[0]?.source).toContain('disconnectSession(session, "cancelled", false)');
    expect(result.summary).toContain("cancelled");
    expect(result.data).not.toHaveProperty("playbook");
    expect(result.data).toMatchObject({ discarded: 19, connectionsDisconnected: 12 });
  });
});
