# 3. Plugin tool contract and registry

- **Status:** Accepted
- **Date:** 2026-06-22
- **Related:** `src/application/tool/define-tool.ts`, `src/application/tool/tool.ts`, `src/application/tool/registry.ts`, `src/application/services/tool-invoker.ts`

## Context

The toolkit has 176 tools across 16 categories. In the legacy code each tool was a `register(server)` function that called `server.registerTool(...)` and reached into transport helpers (`sendAndWait`) to dispatch to a client it resolved itself. That ties every tool to the MCP SDK and the transport, repeats client-resolution and error boilerplate in each file, and makes tools impossible to test in isolation.

We need a single, uniform way to author tools that (a) is decoupled from the SDK and transport, (b) infers argument types from one schema, and (c) centralizes the per-call lifecycle so individual tools stay tiny.

## Decision

Define a **plugin tool contract** in the application layer:

- A `Tool` is `{ name, title, description, category, input (zod schema), requiresClient?, mutatesState?, execute(input, ctx) }`.
- Tools are authored exclusively through `defineTool({ … })`, which **infers the input type from the zod schema** (`z.infer<S>`) so a tool never restates its argument types, and defaults `requiresClient` to `true` and `mutatesState` to `false`.
- A tool's `execute` receives only a `ToolContext`: a child `logger`, an `AbortSignal`, the already-resolved `client`, a `runLuau(source, opts)` bound to that client, a read-only `clients` directory, and the per-call `session` controls. **A tool never picks a client, opens a socket, or imports an adapter.**
- A `ToolRegistry` holds the catalog: it rejects duplicate names at boot (`register` throws), lists tools, filters `byCategory`, and reports `categoryCounts`.
- The `ToolInvoker` owns the lifecycle once for all tools: validate against the schema, resolve the target client (when required), build the sandboxed context, time the call, emit metrics, and normalize every failure into a `DomainError`.

Tools are registered centrally (in `src/tools/index.ts`) and handed to the registry at startup by the composition root.

## Consequences

**Positive**

- Tools are tiny and uniform: most are a schema plus a `runLuau` call that returns `{ data }`. The boilerplate that the legacy `sendAndWait` repeated lives once in `ToolInvoker`.
- Tools are **unit-testable** with a mock `ToolContext` — no SDK, socket, or game required.
- Type safety is automatic: the schema is the single source of truth for argument types.
- Duplicate or misnamed tools fail loudly at boot, not silently at call time.
- The `mutatesState` flag gives a uniform, machine-readable safety surface for write tools.

**Negative / costs**

- All 176 legacy tools must be rewritten onto `defineTool` — they cannot be copied verbatim because they depend on the old transport. This is the migration effort tracked in `docs/MIGRATION.md`.
- A small indirection cost: tool authors must learn the `ToolContext` surface instead of calling transport helpers directly (offset by far less per-tool code).

## Alternatives considered

- **Call `server.registerTool` directly in each tool (legacy style).** Rejected: couples every tool to the MCP SDK and transport and makes isolation testing impossible.
- **A class-per-tool hierarchy.** Rejected: heavier than needed; `defineTool` with schema inference is terser and keeps tools as plain data + a function.
- **Auto-discovery by filesystem glob at runtime.** Rejected in favour of an explicit registration list (`src/tools/index.ts`): explicit registration is greppable, fails fast on duplicates, and avoids load-order surprises. The registry still validates uniqueness regardless.
