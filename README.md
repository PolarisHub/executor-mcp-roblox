# Roblox Executor MCP Server

An MCP server that connects an AI client to a live Roblox game. The model calls a tool, the server runs Luau in the game, and hands back structured data. The agent can reverse-engineer scripts, walk the instance tree, spy on remotes, scan memory, hook functions, orchestrate work across many connected clients, and more.

It ships **236 tools** across 21 categories, a dashboard with eight tabs, persistent playbooks and session traces, a token-gated bridge, and a Luau scripting surface (`mcp.*`) that lets one in-game script call any of the server's tools — sequentially, in parallel, batched, or across N clients at once.

## What's in the box

### Tools (236 across 21 categories)

The big ones you'll reach for first:

- **Run code.** `run-luau` executes Luau and returns JSON; `eval-expression` is the one-liner. Everything else is well-tested Luau you didn't have to write.
- **`script` (persistent VM with `mcp.*`).** Write one Luau program that can ALSO call any other tool inline as `mcp.<tool>(args)` and use the result. Globals you define persist across calls (REPL-style); `vm-reset` wipes the VM.
- **`script-fanout`.** Run one script on N connected clients in parallel; per-client `{result, output}` returned with a summary.
- **Reverse engineering.** GC walking, closure constants/upvalues/protos, bytecode disassembly, call graphs, duplicate-function detection, `filtergc`. 34 tools.
- **Remotes.** Inventory, signature inference, live spy, block, replay, raw RakNet capture. 10 tools.
- **Instrumentation.** Hook-and-log, count calls, spoof returns, trace durations.
- **Hidden surfaces.** Actor scripts, nil-parented instances, hidden GUIs, `gethui`, detached remotes.
- **Discovery.** `discover-player-values` auto-ranks candidate money/score/XP paths from leaderstats / Player / ReplicatedStorage with a scored heuristic walk.
- **Playbooks.** Save/list/run/delete named, parameterized Luau snippets persisted to `~/.executor-mcp/playbooks/`.
- **Sessions.** Every tool call appends to a JSONL session trace; `session-list/show/replay` browse and re-execute past traces.
- **Discovery aids.** `list-tools` browses the catalog by category. `suggest-tools` ranks matches by past success.

Run `list-tools` once connected for the full catalog, or `GET /api/tools/schema` for JSON schemas, or `GET /mcp.d.luau` for Luau type declarations any editor with a Luau LSP can consume.

### Dashboard

Open `http://localhost:16384/` once the server's running. Eight tabs, flat-dark, sub-100ms live updates over WebSocket:

- **Clients** — connected games with PlaceId/JobId chips and click-to-explore.
- **Tools** — category-grouped browser of all 236 tools with search.
- **Activity** — live tool-call stream with text/category/outcome filters.
- **Explorer** — Studio-style game tree with real Studio class icons (314 mapped), Properties + Connections panels, paged children with hover prefetch.
- **Brief** — Place/Game/JobId metadata, surface counts (RemoteEvent/Script/Tool), Local Player info, top remotes from the spy buffer, Discover Values button, Fanout-across-all-clients starter.
- **Spy** — paginated table of captured remote calls with copy-as-`mcp.fire` snippets and a filter.
- **Playbooks** — list rail + edit pane + parameter form + Run on selected client + Auto-params button that infers `${param}` from string/number literals.
- **REPL** — Luau textarea with `mcp.*` autocomplete from `/api/tools/schema`, Ctrl+Enter to run on the selected client, Save-as-playbook button.
- **Output** — terminal-style print/warn/error stream with per-script scoping, source filter, and a 1.5K-line ring buffer.

### Scripting (`mcp.*`)

Inside a `script` body, `mcp` is bound to the whole tool surface. Tool names map kebab → camelCase:

```lua
local p = mcp.getPlayers()
local r = mcp.searchInstances({ className = "RemoteEvent" })
print(#p .. " players, " .. #r.instances .. " remotes")

-- batch N independent calls into one round-trip:
local b = mcp.parallel({
  players = function() return mcp.getPlayers() end,
  money   = function() return mcp.discoverPlayerValues({ limit = 5 }) end,
})

-- cross-game pub/sub:
mcp.subscribe("scores", function(payload, fromClientId)
  print("got", payload.score, "from", fromClientId)
end)
mcp.publish("scores", { score = 100 })
```

`mcp.parallel` is a real coroutine scheduler — every `mcp.*` call inside any of the passed functions yields a marker, the scheduler collects markers across all coroutines per round and batches them into ONE `rpc-batch`. A 5-step recipe across 5 coroutines runs in ~5 round trips, not 25.

## How it works

Hexagonal (ports + adapters). The real logic — which client a session targets, how a tool call gets validated and run, what the errors mean — is plain TypeScript that has no idea WebSockets, the MCP SDK, or pino exist. Tests run with fakes; no socket, no SDK, no game.

```
domain/          pure types and rules, no dependencies
application/     ports (interfaces) + use-cases + the Tool contract
infrastructure/  adapters: WebSocket bridge, MCP stdio, pino, dashboard, ...
tools/           the tools themselves, each a defineTool() plugin
interface/       main.ts, the only file that knows about concrete adapters
```

Imports only point inward. `tools` and `infrastructure` lean on `application`, `application` leans on `domain`, and nothing in the core reaches back out.

Adding a tool is one file:

```ts
export default defineTool({
  name: "get-health",
  category: "Inspection",
  input: z.object({ path: z.string() }),
  async execute({ path }, ctx) {
    const hp = await ctx.runLuau(`return ${path}.Humanoid.Health`);
    return { data: { hp } };
  },
});
```

The tool never touches the transport and never picks a client. The invoker resolves the active client first and hands you a `ctx` that's already bound. Longer write-up in [docs/architecture/overview.md](docs/architecture/overview.md); decisions are ADRs under [docs/adr/](docs/adr/).

## Quick start

Need Node 20+ and pnpm.

```bash
pnpm install
pnpm build
pnpm start        # or pnpm dev for watch mode
```

The server speaks MCP over stdin/stdout. Point your client (Claude, Cursor, Windsurf, anything that speaks MCP) at `node /path/to/executor-mcp-roblox/dist/interface/main.js`. Logs go to stderr; stdout is the protocol channel.

### Connecting the game

Paste in your executor (or add to autoexec):

```lua
getgenv().BridgeURL = "localhost:16384"
-- Optional: if the server has ROBLOX_MCP_BRIDGE_TOKEN set, mirror it here.
-- getgenv().BridgeToken = "your-shared-secret"
loadstring(game:HttpGet("http://" .. getgenv().BridgeURL .. "/connector.luau"))()
```

The connector pulls itself from the server, opens a WebSocket to `ws://<BridgeURL>/bridge`, sends a `hello` with its identity + probed capabilities, and from then on runs whatever the server asks and replies with JSON. Wire shapes live in [src/domain/protocol/messages.ts](src/domain/protocol/messages.ts).

## Configuration

Read once at startup, validated, then passed read-only. No `process.env` access after that.

| Flag              | Env var                        | Default     |                                                                                                       |
| ----------------- | ------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------- |
| `--port`          | `ROBLOX_MCP_PORT`              | `16384`     | Bridge + dashboard port.                                                                              |
| `--host`          | `ROBLOX_MCP_HOST`              | `127.0.0.1` | Bind address. Keep on loopback unless you've thought about it.                                        |
| `--session-label` | `ROBLOX_MCP_SESSION_LABEL`     | generated   | Friendly name for this process.                                                                       |
| `--no-dashboard`  |                                | off         | Disable the dashboard entirely.                                                                       |
|                   | `ROBLOX_MCP_BRIDGE_TOKEN`      | unset       | When set, the bridge AND dashboard require this token. Connector reads `getgenv().BridgeToken`.       |
|                   | `ROBLOX_MCP_LOG_LEVEL`         | `info`      | `trace` through `fatal`.                                                                              |
|                   | `ROBLOX_MCP_LOG_PRETTY`        | off         | `1` for human-readable logs.                                                                          |
|                   | `ROBLOX_MCP_SCRIPT_DIRS`       | —           | Extra folders `execute-file` may read.                                                                |
|                   | `ROBLOX_MCP_EMBEDDINGS_URL`    | local       | Embeddings endpoint for semantic search (Ollama / OpenAI-compatible).                                 |
|                   | `ROBLOX_MCP_EMBEDDINGS_MODEL`  | `embeddinggemma` | Model name passed to the embeddings endpoint.                                                    |

Other defaults: 30s default per-call timeout, thread identity 8, connector heartbeat every 2s. The default per-script RPC budget is 500 `mcp.*` calls; scripts can opt in to more via the `script` tool's `rpcBudget` input.

### Persistent storage

The server writes to a few places under `~/.executor-mcp/`:

- `playbooks/<name>.json` — saved Luau snippets via `playbook-save` or the dashboard.
- `sessions/<sessionId>.jsonl` — append-only trace of every tool call (one line each); read via `session-show`, replayed via `session-replay`.
- `embeddings.json` — sha256-keyed cache for semantic search; cold-start re-embeds drop from minutes to seconds.

## Safety

Read this once.

- The server runs arbitrary code on your game client. That's the whole point. Only connect AI clients you trust.
- The bridge binds `127.0.0.1` by default. If you switch `--host` to `0.0.0.0`, keep it behind a LAN, VPN, or SSH tunnel — never the open internet.
- For shared multi-user machines, set `ROBLOX_MCP_BRIDGE_TOKEN` to a random string. The bridge then rejects WebSocket handshakes without a matching `getgenv().BridgeToken`, and the dashboard requires the same token via cookie or `X-Executor-MCP-Token` header.
- Tools that mutate game state carry `mutatesState: true` and say so in their description; the risky surface is easy to spot.
- `session-replay` skips originally-failed steps and refuses to replay flagged-mutating tools unless `includeMutating:true` is set explicitly; it also refuses to recursively call itself.
- The per-script RPC budget (default 500) caps how much damage a runaway loop in a `script` can do before the bridge cuts it off.

## Layout

```text
src/
  domain/          pure types and rules
  application/     ports, use-cases, the Tool contract
  infrastructure/  adapters: bridge, MCP stdio, dashboard, semantic, playbooks, sessions, config
  tools/           one folder per category, each tool its own defineTool() file
  interface/       main.ts, the composition root
connector/         the in-game Luau connector
assets/            Studio class-icons sprite sheet
docs/              architecture notes + ADRs
test/              unit + integration + helpers
```

## Scripts

| Command                     |                                                                 |
| --------------------------- | --------------------------------------------------------------- |
| `pnpm verify`               | typecheck, lint, and all 289 tests. What CI runs.               |
| `pnpm test`                 | Vitest (`test:coverage` / `test:watch` variants exist).         |
| `pnpm build`                | Compile to `dist/`.                                             |
| `pnpm dev`                  | Run the server under `tsx watch`.                               |
| `pnpm lint` / `pnpm format` | ESLint and Prettier.                                            |

## Tests

The core is genuinely easy to test, which was the point of laying it out this way. `resolveSelection`, the error mapping, `ToolInvoker`, `SessionManager`, `ScriptBridge`, `FsSavedScriptsStore`, `FsSessionLogger`, `CachedEmbeddingsProvider`, and the preflight all run against fake ports — no socket, no SDK, no game. The bridge has full integration tests under [test/integration/](test/integration/) that drive a real `ws` client through the protocol end-to-end, covering rpc-call, rpc-batch, pub/sub, and auth.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the layer rules, how to add a tool, and the PR checklist.

## License

MIT. See [LICENSE](LICENSE).
