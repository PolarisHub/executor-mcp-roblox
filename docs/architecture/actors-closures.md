# Actors, Lua states, and closures

The MCP exposes Volt's complete documented [Actors](https://docs.voltbz.net/docs/actors),
[LuaStateProxy](https://docs.voltbz.net/docs/luastateproxy), and
[Closures](https://docs.voltbz.net/docs/closures) surfaces as capability-guarded tools.

## Agent workflow

1. Call `actor-capabilities` or `closure-capabilities` before choosing a low-level operation.
2. Discover a concrete Actor, state, script, or function expression.
3. Inspect it with `get-lua-state`, `list-lua-states`, or `inspect-closure`.
4. Use execution, fire, hook, restore, environment, or stack-visibility tools only with explicit mutation approval.
5. Poll bounded monitors instead of repeating full scans, then stop monitors when finished.

`tool-plan` recognizes Actor/LuaState and closure goals and returns these capability-first workflows.

## Non-serializable handles

Functions, LuaStateProxy objects, and communication channels cannot cross the JSON bridge directly.
The tools retain them in executor-local registries and return reusable Luau expressions:

- `getgenv().__mcp_closure_refs[key]`
- `getgenv().__mcp_lua_states[stateId]`
- `getgenv().__mcp_comm_channels[channelId]`

Use `list-closure-references` and `release-closure-reference` to inspect or clean retained function handles.

## Actors and LuaStateProxy

The Actor/state family covers:

- discovery and capability probing;
- `run_on_actor`, `getluastate`, `getgamestate`, `getactorstates`, `isparallel`;
- `LuaStateProxy.new`, `Id`, `IsActorState`, `GetActors`, `Execute`, and `Event`;
- communication-channel create/get/fire and message monitoring;
- `on_actor_added` and `on_actor_state_created` monitoring.

Actor and LuaStateProxy execution is asynchronous. A successful result means the source was scheduled, not that its
logical goal succeeded. Use a communication channel or state/channel monitor for completion evidence.

Every monitor uses a 200-event ring buffer, replaces and disconnects an older monitor with the same key, and supports
explicit `start`, `poll`, and `stop` operations.

Volt builds differ slightly at runtime. The implementation accepts actor lifecycle events exposed either as a direct
signal or through an `.Event` wrapper, reports a missing `on_actor_added` capability instead of assuming it exists, and
uses `get-game-state` separately because `getactorstates()` may omit the main game state when no Actor states exist.

## Closures

In addition to existing constant/upvalue/proto/environment and hook tools, the closure family covers every documented
Volt primitive: `checkcaller`, clone/hash, C/L/executor/new-C classification, hook-state inspection, `newcclosure`,
`newlclosure`, `restorefunction`, and `setstackhidden`. It also provides retained handles, typed invocation, environment
replacement, and a complete capability matrix.

Function-returning operations store their results rather than attempting to serialize a raw function. Hooking and
restoration remain compatible with the existing `list-hooks` and `restore-hook` registry.

## Mutation boundaries

Tools that execute source, invoke functions, fire events/channels, restore functions, replace environments, alter stack
visibility, or manage persistent monitors are marked as mutating. They refuse before any Luau runs unless
`confirm=true`. Read-only probes and metadata inspection degrade to `{ error }` when the executor lacks a primitive.
