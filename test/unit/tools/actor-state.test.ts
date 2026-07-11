import { describe, expect, it } from "vitest";

import { matchWorkflows } from "../../../src/application/services/tool-discovery.js";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import { actorsHiddenTools } from "../../../src/tools/actors-hidden/index.js";
import { silentLogger } from "../../helpers/fakes.js";

function mockContext(returnValue: unknown = { ok: true }): {
  ctx: ToolContext;
  calls: Array<{ source: string; options?: LuauOptions }>;
} {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const ctx = {
    logger: silentLogger(),
    signal: new AbortController().signal,
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return returnValue;
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

const addedNames = [
  "actor-capabilities",
  "run-on-actor",
  "get-lua-state",
  "get-game-state",
  "list-lua-states",
  "new-lua-state-proxy",
  "get-lua-state-actors",
  "execute-lua-state",
  "fire-lua-state-event",
  "is-parallel-context",
  "create-comm-channel",
  "get-comm-channel",
  "fire-comm-channel",
  "actor-event-monitor",
  "comm-channel-monitor",
  "lua-state-event-monitor",
] as const;

function tool(name: string) {
  const found = actorsHiddenTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

describe("Actors and LuaStateProxy tools", () => {
  it("registers the complete added surface with unique names", () => {
    const names = actorsHiddenTools.map((candidate) => candidate.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of addedNames) {
      expect(names).toContain(name);
      expect(tool(name).category).toBe("Actors & Hidden");
    }
  });

  it("labels every execution/fire/monitor operation as mutating", () => {
    const names = [
      "run-on-actor",
      "execute-lua-state",
      "fire-lua-state-event",
      "create-comm-channel",
      "fire-comm-channel",
      "actor-event-monitor",
      "comm-channel-monitor",
      "lua-state-event-monitor",
    ];
    for (const name of names) {
      expect(tool(name).mutatesState).toBe(true);
      expect(tool(name).description).toContain("WRITES LIVE GAME STATE");
    }
  });

  it("refuses execution, fire, create, and monitor lifecycle actions without confirmation", async () => {
    const cases: Array<{ name: string; input: Record<string, unknown> }> = [
      {
        name: "run-on-actor",
        input: { actorPath: "workspace.Actor", source: "return", confirm: false },
      },
      { name: "execute-lua-state", input: { state: "current", source: "return", confirm: false } },
      { name: "fire-lua-state-event", input: { state: "current", arguments: [], confirm: false } },
      { name: "create-comm-channel", input: { name: "test", confirm: false } },
      { name: "fire-comm-channel", input: { id: "id", arguments: [], confirm: false } },
      { name: "actor-event-monitor", input: { action: "start", key: "x", confirm: false } },
      { name: "comm-channel-monitor", input: { action: "stop", key: "x", confirm: false } },
      { name: "lua-state-event-monitor", input: { action: "start", key: "x", confirm: false } },
    ];
    for (const item of cases) {
      const { ctx, calls } = mockContext();
      const result = await tool(item.name).execute(item.input, ctx);
      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    }
  });

  it("runs actor source with typed varargs and guarded Actor validation", async () => {
    const { ctx, calls } = mockContext();
    await tool("run-on-actor").execute(
      {
        actorPath: 'getactors()[1]["child"]',
        source: "print(...) ",
        arguments: [
          { kind: "string", value: "arg1" },
          { kind: "number", value: 2 },
        ],
        confirm: true,
        threadContext: 6,
      },
      ctx,
    );
    const call = calls[0]!;
    expect(call.source).toContain('type(run_on_actor) ~= "function"');
    expect(call.source).toContain('__evalActorExpression("getactors()[1][\\"child\\"]")');
    expect(call.source).toContain('local args = { "arg1", 2 }');
    expect(call.source).toContain("pcall(run_on_actor, actor");
    expect(call.options).toEqual({ threadContext: 6, timeoutMs: 30000 });
  });

  it("serializes and retains LuaStateProxy handles instead of returning raw proxies", async () => {
    const { ctx, calls } = mockContext();
    await tool("get-lua-state").execute({ targetExpression: "workspace.Actor" }, ctx);
    const source = calls[0]?.source ?? "";
    expect(source).toContain("pcall(getluastate, target)");
    expect(source).toContain("genv.__mcp_lua_states");
    expect(source).toContain("result.reference");
    expect(source).toContain("state:GetActors()");

    await tool("new-lua-state-proxy").execute({}, ctx);
    expect(calls[1]?.source).toContain("LuaStateProxy.new");
    expect(calls[1]?.source).toContain("pcall(LuaStateProxy.new)");
  });

  it("caps state and actor enumeration", async () => {
    const { ctx, calls } = mockContext();
    await tool("list-lua-states").execute({ includeActors: true }, ctx);
    expect(calls[0]?.source).toContain("math.min(#states, 256)");
    expect(calls[0]?.source).toContain("math.min(#actors, 200)");
    expect(calls[0]?.options?.timeoutMs).toBe(30000);
  });

  it("executes state source and fires state/channel events with typed arguments", async () => {
    const { ctx, calls } = mockContext();
    await tool("execute-lua-state").execute(
      {
        state: "game",
        stateExpression: "",
        source: "print(...)",
        arguments: [{ kind: "boolean", value: true }],
        confirm: true,
      },
      ctx,
    );
    expect(calls[0]?.source).toContain('__resolveState("game"');
    expect(calls[0]?.source).toContain('local sourceText = "print(...)"');
    expect(calls[0]?.source).toContain("proxy:Execute(sourceText, table.unpack(args");

    await tool("fire-comm-channel").execute(
      {
        id: "channel-1",
        arguments: [{ kind: "string", value: "hello" }],
        confirm: true,
      },
      ctx,
    );
    expect(calls[1]?.source).toContain('local id = "channel-1"');
    expect(calls[1]?.source).toContain('local args = { "hello" }');
    expect(calls[1]?.source).toContain("channel:Fire(table.unpack(args");
  });

  it("uses bounded persistent monitor registries with cleanup", async () => {
    const { ctx, calls } = mockContext();
    await tool("actor-event-monitor").execute(
      { action: "start", key: "actors", events: "both", confirm: true },
      ctx,
    );
    const actorSource = calls[0]?.source ?? "";
    expect(actorSource).toContain("__mcp_actor_event_monitors");
    expect(actorSource).toContain("on_actor_added");
    expect(actorSource).toContain("on_actor_state_created");
    expect(actorSource).toContain("and event or container");
    expect(actorSource).toContain("if #buffer > 200 then table.remove(buffer, 1) end");
    expect(actorSource).toContain("__disconnect(connection)");
    expect(calls[0]?.options?.env).toBe("vm");

    await tool("comm-channel-monitor").execute(
      { action: "start", key: "channel", id: "id", confirm: true },
      ctx,
    );
    expect(calls[1]?.source).toContain("__mcp_comm_channel_monitors");
    expect(calls[1]?.source).toContain("event:Connect(function(...)");

    await tool("lua-state-event-monitor").execute(
      { action: "poll", key: "state", limit: 50, clear: true },
      ctx,
    );
    expect(calls[2]?.source).toContain("__mcp_lua_state_event_monitors");
    expect(calls[2]?.source).toContain("__readMonitor(monitor, 50, true)");
  });

  it("probes aliases and event objects without invoking them", async () => {
    const { ctx, calls } = mockContext();
    await tool("actor-capabilities").execute({}, ctx);
    const source = calls[0]?.source ?? "";
    expect(source).toContain('type(get_actors) == "function"');
    expect(source).toContain('type(is_parallel) == "function"');
    expect(source).toContain("on_actor_added = eventInfo(on_actor_added)");
    expect(source).toContain("on_actor_state_created = eventInfo(on_actor_state_created)");
    expect(source).toContain("LuaStateProxy.new");
  });

  it("routes Actor/LuaState goals into a capability-first workflow", () => {
    const matches = matchWorkflows(
      "inspect and execute an actor lua state",
      new Set([
        "actor-capabilities",
        "list-actors",
        "list-lua-states",
        "get-lua-state",
        "run-on-actor",
      ]),
    );
    const actor = matches.find((match) => match.id === "inspect-actor-state");
    expect(actor?.steps.map((step) => step.tool)).toEqual([
      "actor-capabilities",
      "list-actors",
      "list-lua-states",
      "get-lua-state",
      "run-on-actor",
    ]);
  });

  it("parses defaults and generates concrete Luau for every added tool", async () => {
    const rawInputs: Record<string, Record<string, unknown>> = {
      "actor-capabilities": {},
      "run-on-actor": { actorPath: "workspace.Actor", source: "return", confirm: true },
      "get-lua-state": {},
      "get-game-state": {},
      "list-lua-states": {},
      "new-lua-state-proxy": {},
      "get-lua-state-actors": {},
      "execute-lua-state": { source: "return", confirm: true },
      "fire-lua-state-event": { confirm: true },
      "is-parallel-context": {},
      "create-comm-channel": { confirm: true },
      "get-comm-channel": { id: "channel" },
      "fire-comm-channel": { id: "channel", confirm: true },
      "actor-event-monitor": { action: "start", confirm: true },
      "comm-channel-monitor": { action: "start", id: "channel", confirm: true },
      "lua-state-event-monitor": { action: "start", confirm: true },
    };
    for (const name of addedNames) {
      const target = tool(name);
      const input = target.input.parse(rawInputs[name]);
      const { ctx, calls } = mockContext();
      await target.execute(input, ctx);
      expect(calls, name).toHaveLength(1);
      expect(calls[0]?.source, name).not.toContain("undefined");
    }
  });
});
