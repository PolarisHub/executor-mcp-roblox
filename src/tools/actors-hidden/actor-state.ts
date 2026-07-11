import { z } from "zod";

import type { Tool } from "../../application/tool/tool.js";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, valueArgSchema } from "../_shared/reflection.js";
import { q } from "../_shared/luau.js";

const CATEGORY = "Actors & Hidden" as const;
const MAX_EVENTS = 200;

const threadContextField = { threadContext: z.number().int().optional() };
const typedArgumentsField = {
  arguments: z.array(valueArgSchema).max(24).optional().default([]),
};
const stateSelectorFields = {
  state: z.enum(["current", "game", "expression"]).optional().default("current"),
  stateExpression: z
    .string()
    .optional()
    .default("")
    .describe(
      "For state='expression', a Luau expression resolving to a LuaStateProxy, Actor, or BaseScript.",
    ),
};

const ACTOR_STATE_PRELUDE = `
local function __evalActorExpression(expression)
  local chunk, compileError = loadstring("return " .. expression)
  if not chunk then return nil, "compile error in expression: " .. tostring(compileError) end
  local ok, value = pcall(chunk)
  if not ok then return nil, "error evaluating expression: " .. tostring(value) end
  return value, nil
end

local function __instanceInfo(instance)
  if typeof(instance) ~= "Instance" then return nil end
  local result = { name = instance.Name, class = instance.ClassName }
  local ok, fullName = pcall(function() return instance:GetFullName() end)
  if ok then result.fullName = fullName end
  return result
end

local function __eventValue(value, depth)
  depth = depth or 0
  local kind = typeof(value)
  if kind == "nil" or kind == "string" or kind == "number" or kind == "boolean" then return value end
  if kind == "Instance" then return { __type = "Instance", value = __instanceInfo(value) } end
  if kind == "table" and depth < 2 then
    local result = {}
    local count = 0
    local ok = pcall(function()
      for key, child in pairs(value) do
        count = count + 1
        if count > 30 then result.__truncated = true; break end
        result[tostring(key)] = __eventValue(child, depth + 1)
      end
    end)
    if ok then return result end
  end
  local ok, text = pcall(tostring, value)
  return { __type = kind, value = ok and text or "<unprintable>" }
end

local function __stateRegistry()
  if type(getgenv) ~= "function" then return nil end
  local ok, genv = pcall(getgenv)
  if not ok or type(genv) ~= "table" then return nil end
  if type(genv.__mcp_lua_states) ~= "table" then genv.__mcp_lua_states = {} end
  return genv.__mcp_lua_states
end

local function __stateInfo(state, includeActors)
  if state == nil then return nil, "LuaStateProxy is nil" end
  local result = { proxyType = typeof(state), actors = {} }
  local okId, id = pcall(function() return state.Id end)
  if not okId then return nil, "value does not expose LuaStateProxy.Id: " .. tostring(id) end
  result.id = id
  local okActor, isActorState = pcall(function() return state.IsActorState end)
  if okActor then result.isActorState = isActorState == true end
  local okEvent, event = pcall(function() return state.Event end)
  if okEvent and event ~= nil then result.eventType = typeof(event) end
  if includeActors ~= false then
    local okActors, actors = pcall(function() return state:GetActors() end)
    if okActors and type(actors) == "table" then
      result.actorCount = #actors
      for i = 1, math.min(#actors, 200) do result.actors[#result.actors + 1] = __instanceInfo(actors[i]) end
      result.actorsTruncated = #actors > 200
    end
  end
  local registry = __stateRegistry()
  if registry then
    local key = tostring(id)
    registry[key] = state
    result.reference = "getgenv().__mcp_lua_states[" .. string.format("%q", key) .. "]"
  end
  return result, nil
end

local function __resolveState(mode, expression)
  if mode == "current" then
    if type(getluastate) ~= "function" then return nil, "getluastate is not available in this executor." end
    local ok, state = pcall(getluastate)
    if not ok then return nil, "getluastate failed: " .. tostring(state) end
    return state, nil
  end
  if mode == "game" then
    if type(getgamestate) ~= "function" then return nil, "getgamestate is not available in this executor." end
    local ok, state = pcall(getgamestate)
    if not ok then return nil, "getgamestate failed: " .. tostring(state) end
    return state, nil
  end
  if expression == "" then return nil, "stateExpression is required when state='expression'." end
  local value, evalError = __evalActorExpression(expression)
  if evalError then return nil, evalError end
  local okId = pcall(function() return value.Id end)
  if okId then return value, nil end
  if type(getluastate) ~= "function" then return nil, "expression is not a LuaStateProxy and getluastate is unavailable." end
  local ok, state = pcall(getluastate, value)
  if not ok then return nil, "getluastate(target) failed: " .. tostring(state) end
  return state, nil
end

local function __pushBounded(buffer, value)
  buffer[#buffer + 1] = value
  if #buffer > ${MAX_EVENTS} then table.remove(buffer, 1) end
end

local function __readMonitor(monitor, limit, clear)
  local result = {}
  local first = math.max(1, #monitor.events - limit + 1)
  for i = first, #monitor.events do result[#result + 1] = monitor.events[i] end
  if clear then monitor.events = {} end
  return result
end

local function __disconnect(connection)
  if connection == nil then return end
  pcall(function()
    if type(connection.Disconnect) == "function" then connection:Disconnect()
    elseif type(connection.disconnect) == "function" then connection:disconnect() end
  end)
end
`;

function argsSource(args: z.infer<typeof valueArgSchema>[]): string {
  return args.map(buildValueExpr).join(", ");
}

function actorConfirmError(action: string): { data: { error: string }; isError: true } {
  return {
    data: { error: `Refusing to ${action} (writes executor/game state); pass confirm=true.` },
    isError: true,
  };
}

const actorCapabilities = defineTool({
  name: "actor-capabilities",
  title: "Probe Actors, LuaStateProxy, channels, and actor events",
  description:
    "Read-only matrix for Volt's complete Actors and LuaStateProxy surface, including event objects and aliases.",
  category: CATEGORY,
  input: z.object(threadContextField),
  async execute({ threadContext }, ctx) {
    const source = `
local functions = {
  getactors = type(getactors) == "function" or type(get_actors) == "function",
  run_on_actor = type(run_on_actor) == "function",
  getluastate = type(getluastate) == "function",
  getgamestate = type(getgamestate) == "function",
  getactorstates = type(getactorstates) == "function",
  isparallel = type(isparallel) == "function" or type(is_parallel) == "function",
  create_comm_channel = type(create_comm_channel) == "function",
  get_comm_channel = type(get_comm_channel) == "function",
  LuaStateProxy_new = type(LuaStateProxy) == "table" and type(LuaStateProxy.new) == "function",
}
local function eventInfo(value)
  if value == nil then return { available = false } end
  local ok, event = pcall(function() return value.Event end)
  local signal = (ok and event ~= nil) and event or value
  local okConnect, connect = pcall(function() return signal.Connect end)
  return {
    available = okConnect and type(connect) == "function",
    objectType = typeof(value),
    signalType = typeof(signal),
    wrappedEvent = ok and event ~= nil,
  }
end
local total, available = 0, 0
for _, value in pairs(functions) do total = total + 1; if value then available = available + 1 end end
local events = {
  on_actor_added = eventInfo(on_actor_added),
  on_actor_state_created = eventInfo(on_actor_state_created),
}
return { ok = true, total = total, availableCount = available, missingCount = total - available, functions = functions, events = events }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 15000 }) };
  },
});

const runOnActor = defineTool({
  name: "run-on-actor",
  title: "Schedule Luau source on an Actor's isolated state",
  description:
    "WRITES LIVE GAME STATE. Resolve an Actor expression and call run_on_actor(actor, source, ...arguments). The " +
    "operation is asynchronous and returns scheduling metadata, not the actor script's return value. Requires confirm=true.",
  category: CATEGORY,
  mutatesState: true,
  input: z.object({
    actorPath: z.string().min(1),
    source: z.string().min(1).max(500_000),
    ...typedArgumentsField,
    confirm: z.boolean().default(false),
    ...threadContextField,
  }),
  async execute({ actorPath, source: actorSource, arguments: args, confirm, threadContext }, ctx) {
    if (confirm !== true) return actorConfirmError("run code on an Actor");
    const source = `
${ACTOR_STATE_PRELUDE}
if type(run_on_actor) ~= "function" then return { error = "run_on_actor is not available in this executor." } end
local actor, err = __evalActorExpression(${q(actorPath)})
if err then return { error = err } end
if typeof(actor) ~= "Instance" or not actor:IsA("Actor") then return { error = "actorPath did not resolve to an Actor." } end
local args = { ${argsSource(args)} }
local sourceText = ${q(actorSource)}
local ok, failure = pcall(run_on_actor, actor, sourceText, table.unpack(args, 1, #args))
if not ok then return { error = "run_on_actor failed: " .. tostring(failure) } end
return { ok = true, scheduled = true, actor = __instanceInfo(actor), argumentCount = #args, sourceBytes = #sourceText }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 30000 }) };
  },
});

const getLuaState = defineTool({
  name: "get-lua-state",
  title: "Get the current, Actor, or script LuaStateProxy",
  description:
    "Call getluastate() for the current state, or getluastate(target) for an Actor/BaseScript expression. Returns " +
    "serializable Id/IsActorState/Event/Actors metadata plus a reusable registry Reference.",
  category: CATEGORY,
  input: z.object({
    targetExpression: z.string().optional().default(""),
    ...threadContextField,
  }),
  async execute({ targetExpression, threadContext }, ctx) {
    const source = `
${ACTOR_STATE_PRELUDE}
if type(getluastate) ~= "function" then return { error = "getluastate is not available in this executor." } end
local ok, state
if ${q(targetExpression)} == "" then
  ok, state = pcall(getluastate)
else
  local target, err = __evalActorExpression(${q(targetExpression)})
  if err then return { error = err } end
  ok, state = pcall(getluastate, target)
end
if not ok then return { error = "getluastate failed: " .. tostring(state) } end
local info, infoError = __stateInfo(state, true)
if infoError then return { error = infoError } end
info.ok = true
info.targetExpression = ${q(targetExpression)} ~= "" and ${q(targetExpression)} or nil
return info
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000 }) };
  },
});

const getGameState = defineTool({
  name: "get-game-state",
  title: "Get the default game LuaStateProxy",
  description:
    "Call getgamestate() and return Id/IsActorState/Event/Actors metadata plus a reusable registry Reference.",
  category: CATEGORY,
  input: z.object(threadContextField),
  async execute({ threadContext }, ctx) {
    const source = `
${ACTOR_STATE_PRELUDE}
if type(getgamestate) ~= "function" then return { error = "getgamestate is not available in this executor." } end
local ok, state = pcall(getgamestate)
if not ok then return { error = "getgamestate failed: " .. tostring(state) } end
local info, infoError = __stateInfo(state, true)
if infoError then return { error = infoError } end
info.ok = true
info.gameState = true
return info
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000 }) };
  },
});

const listLuaStates = defineTool({
  name: "list-lua-states",
  title: "List every active LuaStateProxy",
  description:
    "Call getactorstates(), cap output at 256 states, and return compact state/actor metadata plus reusable References.",
  category: CATEGORY,
  input: z.object({
    includeActors: z.boolean().optional().default(true),
    ...threadContextField,
  }),
  async execute({ includeActors, threadContext }, ctx) {
    const source = `
${ACTOR_STATE_PRELUDE}
if type(getactorstates) ~= "function" then return { error = "getactorstates is not available in this executor." } end
local ok, states = pcall(getactorstates)
if not ok or type(states) ~= "table" then return { error = "getactorstates failed or did not return a table." } end
local out = {}
for i = 1, math.min(#states, 256) do
  local info = __stateInfo(states[i], ${includeActors ? "true" : "false"})
  if info then out[#out + 1] = info end
end
return { ok = true, count = #states, returned = #out, truncated = #states > #out, states = out }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 30000 }) };
  },
});

const newLuaStateProxy = defineTool({
  name: "new-lua-state-proxy",
  title: "Construct a LuaStateProxy for the current state",
  description:
    "Call LuaStateProxy.new() and return serializable state metadata plus a retained Reference; no raw proxy crosses JSON.",
  category: CATEGORY,
  input: z.object(threadContextField),
  async execute({ threadContext }, ctx) {
    const source = `
${ACTOR_STATE_PRELUDE}
if type(LuaStateProxy) ~= "table" or type(LuaStateProxy.new) ~= "function" then
  return { error = "LuaStateProxy.new is not available in this executor." }
end
local ok, state = pcall(LuaStateProxy.new)
if not ok then return { error = "LuaStateProxy.new failed: " .. tostring(state) } end
local info, infoError = __stateInfo(state, true)
if infoError then return { error = infoError } end
info.ok = true
info.constructed = true
return info
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000 }) };
  },
});

const getLuaStateActors = defineTool({
  name: "get-lua-state-actors",
  title: "List Actors associated with one LuaStateProxy",
  description:
    "Resolve current/game/expression state, call LuaStateProxy:GetActors(), and return at most 200 Actor paths.",
  category: CATEGORY,
  input: z.object({ ...stateSelectorFields, ...threadContextField }),
  async execute({ state, stateExpression, threadContext }, ctx) {
    const source = `
${ACTOR_STATE_PRELUDE}
local proxy, err = __resolveState(${q(state)}, ${q(stateExpression)})
if err then return { error = err } end
local ok, actors = pcall(function() return proxy:GetActors() end)
if not ok or type(actors) ~= "table" then return { error = "LuaStateProxy:GetActors failed: " .. tostring(actors) } end
local out = {}
for i = 1, math.min(#actors, 200) do out[#out + 1] = __instanceInfo(actors[i]) end
local info = __stateInfo(proxy, false)
return { ok = true, state = info, count = #actors, returned = #out, truncated = #actors > #out, actors = out }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000 }) };
  },
});

const executeLuaState = defineTool({
  name: "execute-lua-state",
  title: "Schedule source on a LuaStateProxy",
  description:
    "WRITES LIVE GAME STATE. Resolve current/game/expression state and call LuaStateProxy:Execute(source, ...args). " +
    "Execution is asynchronous and confirmation-gated.",
  category: CATEGORY,
  mutatesState: true,
  input: z.object({
    ...stateSelectorFields,
    source: z.string().min(1).max(500_000),
    ...typedArgumentsField,
    confirm: z.boolean().default(false),
    ...threadContextField,
  }),
  async execute(
    { state, stateExpression, source: stateSource, arguments: args, confirm, threadContext },
    ctx,
  ) {
    if (confirm !== true) return actorConfirmError("execute code on a Lua state");
    const source = `
${ACTOR_STATE_PRELUDE}
local proxy, err = __resolveState(${q(state)}, ${q(stateExpression)})
if err then return { error = err } end
local args = { ${argsSource(args)} }
local sourceText = ${q(stateSource)}
local ok, failure = pcall(function() proxy:Execute(sourceText, table.unpack(args, 1, #args)) end)
if not ok then return { error = "LuaStateProxy:Execute failed: " .. tostring(failure) } end
return { ok = true, scheduled = true, state = __stateInfo(proxy, false), argumentCount = #args, sourceBytes = #sourceText }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 30000 }) };
  },
});

const fireLuaStateEvent = defineTool({
  name: "fire-lua-state-event",
  title: "Fire a LuaStateProxy's cross-state Event",
  description:
    "WRITES LIVE GAME STATE. Resolve current/game/expression state and call state.Event:Fire(...typed arguments). " +
    "Requires confirm=true because listeners may mutate live behavior.",
  category: CATEGORY,
  mutatesState: true,
  input: z.object({
    ...stateSelectorFields,
    ...typedArgumentsField,
    confirm: z.boolean().default(false),
    ...threadContextField,
  }),
  async execute({ state, stateExpression, arguments: args, confirm, threadContext }, ctx) {
    if (confirm !== true) return actorConfirmError("fire a Lua-state event");
    const source = `
${ACTOR_STATE_PRELUDE}
local proxy, err = __resolveState(${q(state)}, ${q(stateExpression)})
if err then return { error = err } end
local okEvent, event = pcall(function() return proxy.Event end)
if not okEvent or event == nil then return { error = "LuaStateProxy.Event is unavailable." } end
local args = { ${argsSource(args)} }
local ok, failure = pcall(function() event:Fire(table.unpack(args, 1, #args)) end)
if not ok then return { error = "LuaStateProxy.Event:Fire failed: " .. tostring(failure) } end
return { ok = true, fired = true, state = __stateInfo(proxy, false), argumentCount = #args }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000 }) };
  },
});

const isParallelContext = defineTool({
  name: "is-parallel-context",
  title: "Check whether the current executor thread is parallel",
  description: "Call isparallel/is_parallel and return a boolean without changing scheduler state.",
  category: CATEGORY,
  input: z.object(threadContextField),
  async execute({ threadContext }, ctx) {
    const source = `
local predicate = (type(isparallel) == "function" and isparallel) or (type(is_parallel) == "function" and is_parallel)
if type(predicate) ~= "function" then return { error = "isparallel/is_parallel is not available in this executor." } end
local ok, value = pcall(predicate)
if not ok then return { error = "isparallel failed: " .. tostring(value) } end
return { ok = true, isParallel = value == true }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 10000 }) };
  },
});

const createCommChannel = defineTool({
  name: "create-comm-channel",
  title: "Create and retain an Actor communication channel",
  description:
    "WRITES LIVE GAME STATE. Call create_comm_channel(name?), retain the Channel in " +
    "getgenv().__mcp_comm_channels, and return only its serializable identifier/metadata. Requires confirm=true.",
  category: CATEGORY,
  mutatesState: true,
  input: z.object({
    name: z.string().max(96).optional().default(""),
    confirm: z.boolean().default(false),
    ...threadContextField,
  }),
  async execute({ name, confirm, threadContext }, ctx) {
    if (confirm !== true) return actorConfirmError("create a communication channel");
    const source = `
if type(create_comm_channel) ~= "function" then return { error = "create_comm_channel is not available in this executor." } end
local name = ${q(name)}
local ok, id, channel
if name ~= "" then ok, id, channel = pcall(create_comm_channel, name) else ok, id, channel = pcall(create_comm_channel) end
if not ok then return { error = "create_comm_channel failed: " .. tostring(id) } end
if id == nil or channel == nil then return { error = "create_comm_channel did not return both id and channel." } end
if type(getgenv) == "function" then
  local okEnv, genv = pcall(getgenv)
  if okEnv and type(genv) == "table" then
    if type(genv.__mcp_comm_channels) ~= "table" then genv.__mcp_comm_channels = {} end
    genv.__mcp_comm_channels[tostring(id)] = channel
  end
end
local okEvent, event = pcall(function() return channel.Event end)
return { ok = true, id = tostring(id), name = name ~= "" and name or nil, channelType = typeof(channel), eventType = okEvent and typeof(event) or nil }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 15000 }) };
  },
});

const getCommChannel = defineTool({
  name: "get-comm-channel",
  title: "Resolve an existing Actor communication channel",
  description:
    "Call get_comm_channel(id), falling back to the MCP channel registry, and return serializable channel/Event metadata.",
  category: CATEGORY,
  input: z.object({ id: z.string().min(1).max(256), ...threadContextField }),
  async execute({ id, threadContext }, ctx) {
    const source = `
local id = ${q(id)}
local channel = nil
if type(get_comm_channel) == "function" then local ok, value = pcall(get_comm_channel, id); if ok then channel = value end end
if channel == nil and type(getgenv) == "function" then
  local ok, genv = pcall(getgenv)
  if ok and type(genv) == "table" and type(genv.__mcp_comm_channels) == "table" then channel = genv.__mcp_comm_channels[id] end
end
if channel == nil then return { error = "communication channel was not found." } end
local okEvent, event = pcall(function() return channel.Event end)
return { ok = true, id = id, channelType = typeof(channel), eventType = okEvent and typeof(event) or nil, hasEvent = okEvent and event ~= nil }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 10000 }) };
  },
});

const fireCommChannel = defineTool({
  name: "fire-comm-channel",
  title: "Send typed values through an Actor communication channel",
  description:
    "WRITES LIVE GAME STATE. Resolve get_comm_channel(id) and call Channel:Fire(...typed arguments). Requires " +
    "confirm=true because channel listeners may execute arbitrary live behavior.",
  category: CATEGORY,
  mutatesState: true,
  input: z.object({
    id: z.string().min(1).max(256),
    ...typedArgumentsField,
    confirm: z.boolean().default(false),
    ...threadContextField,
  }),
  async execute({ id, arguments: args, confirm, threadContext }, ctx) {
    if (confirm !== true) return actorConfirmError("fire a communication channel");
    const source = `
local id = ${q(id)}
local channel = nil
if type(get_comm_channel) == "function" then local ok, value = pcall(get_comm_channel, id); if ok then channel = value end end
if channel == nil and type(getgenv) == "function" then
  local ok, genv = pcall(getgenv)
  if ok and type(genv) == "table" and type(genv.__mcp_comm_channels) == "table" then channel = genv.__mcp_comm_channels[id] end
end
if channel == nil then return { error = "communication channel was not found." } end
local args = { ${argsSource(args)} }
local ok, failure = pcall(function() channel:Fire(table.unpack(args, 1, #args)) end)
if not ok then return { error = "Channel:Fire failed: " .. tostring(failure) } end
return { ok = true, id = id, fired = true, argumentCount = #args }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 15000 }) };
  },
});

const monitorFields = {
  action: z.enum(["start", "poll", "stop"]),
  key: z.string().min(1).max(96).optional().default("default"),
  limit: z.number().int().min(1).max(MAX_EVENTS).optional().default(100),
  clear: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
  ...threadContextField,
};

const actorEventMonitor = defineTool({
  name: "actor-event-monitor",
  title: "Monitor actor-ready and actor-state-created events",
  description:
    "WRITES LIVE GAME STATE when starting/stopping. Connect to on_actor_added and/or on_actor_state_created, retain " +
    `a bounded ${MAX_EVENTS}-event buffer, and poll it without repeated game-tree scans. Start/stop require confirm=true.`,
  category: CATEGORY,
  mutatesState: true,
  input: z.object({
    ...monitorFields,
    events: z.enum(["both", "added", "state-created"]).optional().default("both"),
  }),
  async execute({ action, key, limit, clear, confirm, events, threadContext }, ctx) {
    if (action !== "poll" && confirm !== true)
      return actorConfirmError(`${action} an actor event monitor`);
    const source = `
${ACTOR_STATE_PRELUDE}
if type(getgenv) ~= "function" then return { error = "getgenv is required for persistent actor monitors." } end
local okEnv, genv = pcall(getgenv)
if not okEnv or type(genv) ~= "table" then return { error = "getgenv failed." } end
if type(genv.__mcp_actor_event_monitors) ~= "table" then genv.__mcp_actor_event_monitors = {} end
local registry = genv.__mcp_actor_event_monitors
local key = ${q(key)}
local action = ${q(action)}
if action == "poll" then
  local monitor = registry[key]
  if not monitor then return { error = "actor event monitor key was not found." } end
  local values = __readMonitor(monitor, ${limit}, ${clear ? "true" : "false"})
  return { ok = true, key = key, running = true, buffered = #monitor.events, events = values }
end
if action == "stop" then
  local monitor = registry[key]
  if not monitor then return { error = "actor event monitor key was not found." } end
  for _, connection in ipairs(monitor.connections or {}) do __disconnect(connection) end
  local buffered = #monitor.events
  registry[key] = nil
  return { ok = true, key = key, stopped = true, buffered = buffered }
end
local previous = registry[key]
if previous then for _, connection in ipairs(previous.connections or {}) do __disconnect(connection) end end
local monitor = { events = {}, connections = {}, kinds = ${q(events)} }
local function record(kind, actor)
  local entry = { kind = kind, actor = __instanceInfo(actor), at = os.clock() }
  if kind == "state-created" and type(getluastate) == "function" then
    local okState, state = pcall(getluastate, actor)
    if okState then entry.state = __stateInfo(state, false) end
  end
  __pushBounded(monitor.events, entry)
end
local function connect(container, kind)
  if container == nil then return false end
  local okEvent, event = pcall(function() return container.Event end)
  local signal = (okEvent and event ~= nil) and event or container
  local okConnect, connection = pcall(function() return signal:Connect(function(actor) record(kind, actor) end) end)
  if okConnect and connection then monitor.connections[#monitor.connections + 1] = connection; return true end
  return false
end
local selected = ${q(events)}
local added = (selected == "both" or selected == "added") and connect(on_actor_added, "added") or false
local created = (selected == "both" or selected == "state-created") and connect(on_actor_state_created, "state-created") or false
if not added and not created then return { error = "requested actor event objects are unavailable." } end
registry[key] = monitor
return { ok = true, key = key, started = true, added = added, stateCreated = created, bufferLimit = ${MAX_EVENTS} }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000, env: "vm" }) };
  },
});

const commChannelMonitor = defineTool({
  name: "comm-channel-monitor",
  title: "Monitor messages on an Actor communication channel",
  description:
    "WRITES LIVE GAME STATE when starting/stopping. Connect to Channel.Event, retain a bounded " +
    `${MAX_EVENTS}-message buffer, and poll by monitor key. Start/stop require confirm=true.`,
  category: CATEGORY,
  mutatesState: true,
  input: z.object({
    ...monitorFields,
    id: z.string().max(256).optional().default(""),
  }),
  async execute({ action, key, id, limit, clear, confirm, threadContext }, ctx) {
    if (action !== "poll" && confirm !== true)
      return actorConfirmError(`${action} a channel monitor`);
    const source = `
${ACTOR_STATE_PRELUDE}
if type(getgenv) ~= "function" then return { error = "getgenv is required for persistent channel monitors." } end
local okEnv, genv = pcall(getgenv)
if not okEnv or type(genv) ~= "table" then return { error = "getgenv failed." } end
if type(genv.__mcp_comm_channel_monitors) ~= "table" then genv.__mcp_comm_channel_monitors = {} end
local registry = genv.__mcp_comm_channel_monitors
local key = ${q(key)}
local action = ${q(action)}
if action == "poll" then
  local monitor = registry[key]
  if not monitor then return { error = "channel monitor key was not found." } end
  local values = __readMonitor(monitor, ${limit}, ${clear ? "true" : "false"})
  return { ok = true, key = key, id = monitor.id, running = true, buffered = #monitor.events, events = values }
end
if action == "stop" then
  local monitor = registry[key]
  if not monitor then return { error = "channel monitor key was not found." } end
  __disconnect(monitor.connection)
  local buffered = #monitor.events
  registry[key] = nil
  return { ok = true, key = key, id = monitor.id, stopped = true, buffered = buffered }
end
local id = ${q(id)}
if id == "" then return { error = "id is required when starting a channel monitor." } end
local channel = nil
if type(get_comm_channel) == "function" then local ok, value = pcall(get_comm_channel, id); if ok then channel = value end end
if channel == nil and type(genv.__mcp_comm_channels) == "table" then channel = genv.__mcp_comm_channels[id] end
if channel == nil then return { error = "communication channel was not found." } end
local previous = registry[key]
if previous then __disconnect(previous.connection) end
local monitor = { id = id, events = {} }
local okEvent, event = pcall(function() return channel.Event end)
if not okEvent or event == nil then return { error = "Channel.Event is unavailable." } end
local okConnect, connection = pcall(function()
  return event:Connect(function(...)
    local packed = table.pack(...)
    local args = {}
    for i = 1, math.min(packed.n, 16) do args[i] = __eventValue(packed[i]) end
    __pushBounded(monitor.events, { at = os.clock(), argumentCount = packed.n, arguments = args, truncated = packed.n > 16 })
  end)
end)
if not okConnect or not connection then return { error = "Channel.Event:Connect failed: " .. tostring(connection) } end
monitor.connection = connection
registry[key] = monitor
return { ok = true, key = key, id = id, started = true, bufferLimit = ${MAX_EVENTS} }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000, env: "vm" }) };
  },
});

const luaStateEventMonitor = defineTool({
  name: "lua-state-event-monitor",
  title: "Monitor a LuaStateProxy's generic cross-state Event",
  description:
    "WRITES LIVE GAME STATE when starting/stopping. Connect to LuaStateProxy.Event, retain a bounded " +
    `${MAX_EVENTS}-event buffer, and poll it by key. Start/stop require confirm=true.`,
  category: CATEGORY,
  mutatesState: true,
  input: z.object({ ...monitorFields, ...stateSelectorFields }),
  async execute(
    { action, key, limit, clear, confirm, state, stateExpression, threadContext },
    ctx,
  ) {
    if (action !== "poll" && confirm !== true)
      return actorConfirmError(`${action} a Lua-state event monitor`);
    const stateMode = state ?? "current";
    const expression = stateExpression ?? "";
    const source = `
${ACTOR_STATE_PRELUDE}
if type(getgenv) ~= "function" then return { error = "getgenv is required for persistent state monitors." } end
local okEnv, genv = pcall(getgenv)
if not okEnv or type(genv) ~= "table" then return { error = "getgenv failed." } end
if type(genv.__mcp_lua_state_event_monitors) ~= "table" then genv.__mcp_lua_state_event_monitors = {} end
local registry = genv.__mcp_lua_state_event_monitors
local key = ${q(key)}
local action = ${q(action)}
if action == "poll" then
  local monitor = registry[key]
  if not monitor then return { error = "Lua-state event monitor key was not found." } end
  local values = __readMonitor(monitor, ${limit}, ${clear ? "true" : "false"})
  return { ok = true, key = key, state = monitor.stateInfo, running = true, buffered = #monitor.events, events = values }
end
if action == "stop" then
  local monitor = registry[key]
  if not monitor then return { error = "Lua-state event monitor key was not found." } end
  __disconnect(monitor.connection)
  local buffered = #monitor.events
  registry[key] = nil
  return { ok = true, key = key, stopped = true, buffered = buffered }
end
local proxy, err = __resolveState(${q(stateMode)}, ${q(expression)})
if err then return { error = err } end
local okEvent, event = pcall(function() return proxy.Event end)
if not okEvent or event == nil then return { error = "LuaStateProxy.Event is unavailable." } end
local previous = registry[key]
if previous then __disconnect(previous.connection) end
local monitor = { events = {}, stateInfo = __stateInfo(proxy, false) }
local okConnect, connection = pcall(function()
  return event:Connect(function(...)
    local packed = table.pack(...)
    local args = {}
    for i = 1, math.min(packed.n, 16) do args[i] = __eventValue(packed[i]) end
    __pushBounded(monitor.events, { at = os.clock(), argumentCount = packed.n, arguments = args, truncated = packed.n > 16 })
  end)
end)
if not okConnect or not connection then return { error = "LuaStateProxy.Event:Connect failed: " .. tostring(connection) } end
monitor.connection = connection
registry[key] = monitor
return { ok = true, key = key, state = monitor.stateInfo, started = true, bufferLimit = ${MAX_EVENTS} }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000, env: "vm" }) };
  },
});

export const actorStateTools: Tool[] = [
  actorCapabilities,
  runOnActor,
  getLuaState,
  getGameState,
  listLuaStates,
  newLuaStateProxy,
  getLuaStateActors,
  executeLuaState,
  fireLuaStateEvent,
  isParallelContext,
  createCommChannel,
  getCommChannel,
  fireCommChannel,
  actorEventMonitor,
  commChannelMonitor,
  luaStateEventMonitor,
];
