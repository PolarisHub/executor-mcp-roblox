# Roblox Executor MCP Server

An MCP server that connects an AI client to a live Roblox game. The model calls a tool, the server runs Luau in the game, and hands back structured data. With that an agent can reverse-engineer scripts, walk the instance tree, spy on remotes, scan memory, hook functions, and a lot more.

It ships **225 tools** across 21 categories.

## What's in the box

Plenty, but the things you'll reach for first:

- Run code. `run-luau` executes arbitrary Luau and returns JSON; `eval-expression` is the one-liner version. Most of the other tools are just well-tested Luau you don't have to write yourself.
- Reverse engineering. Walk the GC, read closure constants and upvalues, cross-reference functions/strings/remotes, dump bytecode, find duplicate functions, and query the heap with `filtergc`.
- Remotes. Inventory them, read their argument shapes, watch traffic, block or replay calls, down to raw RakNet packet capture.
- Instrumentation. Hook-and-log, count calls, spoof return values, profile durations.
- Finding hidden things. Actor scripts, nil-parented instances, hidden GUIs, `gethui`, detached remotes.
- Extras. Filesystem, crypt, drawing, fast flags, WebSocket, HTTP.

Run `list-tools` once you're connected for the full catalog grouped by category.

## How it works

The codebase is hexagonal (ports and adapters). The reason that matters: all the real logic — which client a session targets, how a tool call gets validated and run, what the errors mean — is plain TypeScript that has no idea WebSockets, the MCP SDK, or pino exist. You can test it with fakes and never open a socket.

```
domain/          pure types and rules, no dependencies
application/     ports (interfaces) + use-cases + the Tool contract
infrastructure/  the adapters that implement those ports
tools/           the tools themselves, each a defineTool() plugin
interface/       main.ts, which wires it all together and starts up
```

Imports only point inward. `tools` and `infrastructure` lean on `application`, `application` leans on `domain`, and nothing in the core reaches back out. Exactly one file knows about concrete adapters, and that's `interface/main.ts`.

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

The tool never touches the transport and never picks a client. The invoker resolves the active client first and hands you a `ctx` that's already bound to it.

There's a longer write-up in [docs/architecture/overview.md](docs/architecture/overview.md), and the decisions behind it are recorded as ADRs under [docs/adr/](docs/adr/).

## Quick start

You need Node 20+ and pnpm.

```bash
pnpm install
pnpm build
pnpm start        # or pnpm dev for watch mode
```

The server talks MCP over stdin/stdout, so point your client (Claude, Cursor, Windsurf, anything that speaks MCP) at `node /path/to/executor-mcp-roblox/dist/interface/main.js`. Logs go to stderr; stdout is the protocol channel and stays clean.

### Connecting the game

Paste this in and run it, or add it to autoexec:

```lua
getgenv().BridgeURL = "localhost:16384"
loadstring(game:HttpGet("http://" .. getgenv().BridgeURL .. "/connector.luau"))()
```

It pulls the connector from the server, opens a WebSocket to `ws://<BridgeURL>/bridge`, sends a `hello` with its name and the capabilities it found, and after that just runs whatever the server asks and replies with JSON. The message shapes live in [src/domain/protocol/messages.ts](src/domain/protocol/messages.ts) if you want the details.

## Configuration

Everything is read once at startup, validated, and then passed around read-only. The server doesn't touch `process.env` again after that.

| Flag              | Env var                                | Default     |                                                  |
| ----------------- | -------------------------------------- | ----------- | ------------------------------------------------ |
| `--port`          | `ROBLOX_MCP_PORT`                      | `16384`     | Bridge port.                                     |
| `--host`          | `ROBLOX_MCP_HOST`                      | `127.0.0.1` | Bind address (see Safety below).                 |
| `--session-label` | `ROBLOX_MCP_SESSION_LABEL`             | generated   | Friendly name for this process.                  |
|                   | `ROBLOX_MCP_LOG_LEVEL`                 | `info`      | `trace` through `fatal`.                         |
|                   | `ROBLOX_MCP_LOG_PRETTY`                | off         | Set to `1` for human-readable logs.              |
|                   | `ROBLOX_MCP_SCRIPT_DIRS`               | —           | Extra folders `execute-file` is allowed to read. |
|                   | `ROBLOX_MCP_EMBEDDINGS_URL` / `_MODEL` | local       | Embeddings endpoint for semantic search.         |

A few defaults that aren't flags: 30s per-call timeout, thread identity 8, and a connector heartbeat every 2s.

## Layout

```text
src/
  domain/          pure types and rules, no dependencies
  application/     ports, use-cases, and the Tool contract
  infrastructure/  adapters: WebSocket bridge, MCP stdio, pino, config, ...
  tools/           one folder per category, each tool its own defineTool() file
  interface/       main.ts, the composition root
connector/         the in-game Luau connector
docs/              architecture notes, ADRs, migration history
test/              unit + integration, with shared fakes in test/helpers
```

## Scripts

| Command                     |                                                                 |
| --------------------------- | --------------------------------------------------------------- |
| `pnpm verify`               | typecheck, lint, and tests. This is what CI runs.               |
| `pnpm test`                 | Vitest (`test:coverage` for coverage, `test:watch` to iterate). |
| `pnpm build`                | Compile to `dist/`.                                             |
| `pnpm dev`                  | Run the server under `tsx watch`.                               |
| `pnpm lint` / `pnpm format` | ESLint and Prettier.                                            |

## Safety

Read this once. The server runs arbitrary code on your game client. That's the whole point, but it means you should only connect AI clients you trust. There's no auth on the bridge, so it listens on `127.0.0.1` and isn't reachable from the network. If you switch `--host` to `0.0.0.0`, keep it behind a LAN, VPN, or SSH tunnel and don't put it on the open internet. Tools that change game state carry `mutatesState: true` and say so in their description, so the risky surface is easy to spot.

## Tests

The core is genuinely easy to test, which was the point of laying it out this way. `resolveSelection`, the error mapping, `ToolInvoker`, and `SessionManager` all run against fake ports with no socket, no SDK, and no game. The adapters get their own tests against the port they implement. `pnpm verify` runs everything.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the setup steps, the layer rules, how to add a tool, and the PR checklist.

## License

MIT. See [LICENSE](LICENSE).
