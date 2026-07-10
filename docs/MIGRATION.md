# Migration plan — porting 176 legacy tools onto `defineTool`

> **Status: COMPLETE.** All upstream capabilities have been migrated onto the new
> `defineTool` contract (a handful of legacy tools were merged into cleaner
> equivalents — e.g. `get-data-by-code` → `run-luau`, `get-descendants-tree` →
> `get-instance-tree` — and `list-tools` is now a built-in of the MCP adapter).
> The toolkit now ships **225 tools across 21 categories**: full functional parity
> plus new **Volt power tools** (Filesystem, Crypt, Drawing, RakNet packets,
> WebSocket, HTTP, Fast Flags, `filtergc`, `gethui`, cache, and debug-stack tools).
> The wave history below is retained as a record of how the migration was carried out.

This document is the working plan to migrate the upstream toolkit (the **176 tools** preserved under `_legacy/src/tools/impl/**`) onto the rewrite's `defineTool` contract. It is honest about scope: **wave 0 ships ~10 exemplar tools** that exercise every part of the new contract; the remaining tools land in subsequent waves, category by category.

## Why a migration (not a copy)

Legacy tools are `register(server)` functions that call `server.registerTool(...)` and dispatch through transport helpers (`sendAndWait`, `resolveDispatchClientId`) to a client they resolve themselves. The rewrite forbids that: a tool may touch **only** its `ToolContext`. So each tool is **rewritten**, not lifted — but the rewrite is mechanical, because the legacy tool already contains the two things we keep: its **input schema** and its **Luau body**.

What changes:

| Legacy                                                                                 | New                                                                                |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `server.registerTool(name, { title, description, inputSchema }, handler)`              | `defineTool({ name, title, description, category, input, execute })`               |
| `inputSchema: z.object({ … })`                                                         | `input: z.object({ … })` (type is **inferred** — no restating)                     |
| resolves a client, calls `sendAndWait({ type: "get-data-by-code", data: { source } })` | `await ctx.runLuau(source)` (client already resolved and bound)                    |
| returns `{ content: [{ type: "text", text }] }`                                        | returns `{ data, summary? }` (serialization is the adapter's job)                  |
| `q(...)`, `REFLECT_PRELUDE`, `__eval`/`__encVal` Luau helpers                          | **kept verbatim** — copy the Luau builder + helpers into the new tool              |
| `setThreadIdentity(...)` prepended manually                                            | pass `threadContext` via `ctx.runLuau(source, { threadContext })`                  |
| no explicit category                                                                   | `category` is required (one of the 16 in `domain/tool/category.ts`)                |
| (implicit)                                                                             | set `requiresClient: false` for client-less tools, `mutatesState: true` for writes |

## Authoring pattern

1. **Read the legacy tool** in `_legacy/src/tools/impl/<area>/<name>.ts`. Note its title, description, schema, the Luau it builds, and whether it writes state.
2. **Copy the Luau builder verbatim**, including `q()` (JSON-quote a string into a Luau-legal literal — keep the `\uXXXX → \u{XXXX}` rewrite) and any shared prelude (`REFLECT_PRELUDE`, `__eval`, `__encVal`). These are pure string builders; they belong with the tool (or in a small shared module under `src/tools/`).
3. **Rewrite as `defineTool`.** Move `inputSchema` → `input`; drop the manual client resolution and `sendAndWait`; call `await ctx.runLuau(source, options)`; return `{ data }`.
4. **Pick the category** from the canonical 16. Set `requiresClient: false` for diagnostics/session tools, `mutatesState: true` for any tool that writes live game state.
5. **Register** the tool in `src/tools/index.ts` (explicit registration; the registry rejects duplicate names at boot).
6. **Test** with a mock `ToolContext` — assert the built Luau and the decoded result without a socket or a game.

### Before (legacy, abridged — `actions/set-instance-property.ts`)

```ts
server.registerTool(
  "set-instance-property",
  {
    title: "...",
    description: "WRITES LIVE GAME STATE. ...",
    inputSchema: z.object({
      instancePath: z.string(),
      propertyName: z.string(),
      value: valueArgSchema,
      threadContext: threadContextSchema,
    }),
  },
  async ({ instancePath, propertyName, value, threadContext }) => {
    const source = `${REFLECT_PRELUDE}\nlocal inst, err = __eval(${q(instancePath)}) ... return { Path = path, ... }`;
    return sendAndWait({
      type: "get-data-by-code",
      data: { source: `setthreadidentity(${threadContext});${source}` },
      timeoutMs: 20000,
    });
  },
);
```

### After (new contract)

```ts
import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE, buildValueExpr } from "./reflection-shared.js";

export default defineTool({
  name: "set-instance-property",
  title: "Set a property on a live Instance",
  description:
    "WRITES LIVE GAME STATE. Resolve a Luau expression to an Instance and assign one of its properties...",
  category: "Actions",
  mutatesState: true,
  input: z.object({
    instancePath: z.string(),
    propertyName: z.string(),
    value: valueArgSchema,
    threadContext: z.number().optional(),
  }),
  async execute({ instancePath, propertyName, value, threadContext }, ctx) {
    const source = `${REFLECT_PRELUDE}
local inst, err = __eval(${q(instancePath)})
if err then return { error = err } end
local prop = ${q(propertyName)}
-- ...read old, pcall set, read new...
return { Path = path, Property = prop, OldValue = oldEnc, NewValue = newEnc, ok = true }`;
    const data = await ctx.runLuau(source, threadContext != null ? { threadContext } : undefined);
    return { data };
  },
});
```

The Luau is identical; the wrapper is what changes. The connector now JSON-encodes the returned table (ADR 0002), so `ctx.runLuau` returns the decoded value directly — no manual response parsing.

## Category inventory (target: 176 tools, 16 categories)

Counts are the canonical post-migration totals (the categories are the fixed set in `domain/tool/category.ts`). Run `list-tools` for the live count at any point during the migration.

| Category              | Target # | Scope                                                                                                                                         |
| --------------------- | -------: | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Reverse Engineering   |       30 | GC function discovery, closure constants / upvalues / protos, function hashing, bytecode-size outliers, env & registry inspection             |
| Metatables & Closures |       19 | read/hook metamethods, raw metatables, readonly state, inspect/patch closures, script & function environments, hook management                |
| Signals & Connections |       16 | enumerate connections, fire/replicate signals, read signal arguments, inspect connection internals, replication whitelist                     |
| Inspection            |       15 | decompile/read scripts, CSS-like instance search, descendant trees, game info, properties/attributes, semantic search, console output         |
| Disassembly & Xrefs   |       12 | strings window, string/global/function/instance/remote xrefs, call graphs, disassembly, duplicate & shared-upvalue detection, bytecode search |
| Actions               |       10 | write live state: set property/attribute (single or bulk), create/clone/destroy instances, invoke methods, fire remotes, dump tables/threads  |
| Actors & Hidden       |       10 | Actor scripts, nil-parented/detached instances, hidden scripts/GUIs/remotes, running-script & actor detail, surface summary                   |
| Execution             |       10 | run Luau (sync/await/file/batch/deferred), profile time & memory, looped polling, single-expression eval, watchdog timeout                    |
| Remote Spy            |       10 | remote inventory, signature probing, intercept/log/block/ignore (Cobalt), traffic tracing, single-remote monitoring, callback inspection      |
| Diagnostics           |        9 | bridge/connector status, executor identity & capability matrix, memory/instance/render stats, anti-cheat recon, tool catalog                  |
| GUI                   |       10 | list the GUI tree, read/set text, click buttons, type text, fire ProximityPrompt/ClickDetector, send keyboard/mouse/touch/gamepad input, control the camera |
| Instrumentation       |        8 | hook-and-log, count calls, profile call durations, spoof returns, block functions, capture log output, watch property changes                 |
| Memory Scan           |        8 | search by value/key/number-range/string, read/write any path, find table references, watch a value                                            |
| Session & Client      |        7 | list/select/clear active client (per-session, account-sticky), player roster, local player & place details                                    |
| Semantic Search       |        2 | embedding-indexed script search stats & index management                                                                                      |
| Windows               |        2 | list Roblox windows, capture window screenshots (Windows only)                                                                                |
| **Total**             |  **176** |                                                                                                                                               |

> Note on source layout: the legacy folders under `_legacy/src/tools/impl/` (e.g. `reflection/`, `advanced/`, `clients/`) do **not** map 1:1 to these 16 categories — the legacy `index.ts` groups registrations into categories via `setToolCategory(...)`. When migrating, assign the **category** from the table above, not from the legacy folder name.

## Wave plan

Tools are migrated in waves. Each wave is a reviewable PR that adds a batch of tools and their tests, registers them in `src/tools/index.ts`, and keeps `pnpm verify` green.

| Wave            | Scope                                                                                                                                                     | Tool count | Goal                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0 (current)** | Exemplars across the contract: a couple each of Diagnostics, Session & Client, Execution, Inspection (the folders already scaffolded under `src/tools/`). |        ~10 | Prove the contract end to end — client-bound and client-less tools, a `mutatesState` write, a tool that reads `ctx.clients`, and a tool that drives `ctx.session`. |
| 1               | Session & Client (complete) + Diagnostics (complete)                                                                                                      |        ~16 | The connect/select/inspect baseline an agent needs first.                                                                                                          |
| 2               | Execution (complete) + Inspection (complete)                                                                                                              |        ~25 | Core run + read loop.                                                                                                                                              |
| 3               | Actions + GUI                                                                                                                                             |        ~18 | Write/interaction surface (all `mutatesState`).                                                                                                                    |
| 4               | Reverse Engineering + Disassembly & Xrefs                                                                                                                 |        ~42 | The RE-heavy block; share one reflection-prelude module.                                                                                                           |
| 5               | Metatables & Closures + Signals & Connections                                                                                                             |        ~35 | Reference-by-expression tools.                                                                                                                                     |
| 6               | Remote Spy + Instrumentation                                                                                                                              |        ~18 | Stateful, restorable hooks (depends on Cobalt for spy).                                                                                                            |
| 7               | Actors & Hidden + Memory Scan                                                                                                                             |        ~18 | Discovery/heap-scan block.                                                                                                                                         |
| 8               | Semantic Search + Windows                                                                                                                                 |         ~4 | Tail categories (semantic indexing; Windows-only screenshots).                                                                                                     |

**Batch sizing.** Keep a wave to one or two categories (~10–25 tools) so a PR stays reviewable and the Luau prelude shared by a category is introduced once per wave. Tools that share a prelude (e.g. the reflection helpers) should be migrated together so the shared module lands with its first consumer.

## Per-tool checklist

- [ ] Legacy tool read; title, description, schema, Luau body, and write-vs-read nature noted.
- [ ] Rewritten with `defineTool`; input type **inferred** from the zod schema (no restated types).
- [ ] Luau builder + `q()` + any prelude copied verbatim; `q()`'s `\uXXXX → \u{XXXX}` rewrite preserved.
- [ ] Dispatch is `await ctx.runLuau(source, options)`; no manual client resolution, no `sendAndWait`.
- [ ] `category` set to one of the canonical 16.
- [ ] `requiresClient: false` for client-less tools; `mutatesState: true` for live-state writes (and the description says "WRITES LIVE GAME STATE").
- [ ] `threadContext` / `timeoutMs` passed through `ctx.runLuau` options, not hardcoded into the source.
- [ ] Registered in `src/tools/index.ts` (unique name — the registry throws on duplicates at boot).
- [ ] Unit test with a mock `ToolContext`: asserts the built Luau and the decoded result, no socket/game.
- [ ] Imports end in `.js`; types imported with `import type`; no `console`; `pnpm verify` green.

## Definition of done (per wave)

- All tools in the wave's categories pass the per-tool checklist.
- `list-tools` reports the expected count for those categories.
- `pnpm verify` (typecheck + lint + test) is green on Node 20 and 22.
- The category's shared prelude (if any) lives in one module under `src/tools/` and is unit-tested once.
