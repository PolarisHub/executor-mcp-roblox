# 5. Observability and configuration as ports

- **Status:** Accepted
- **Date:** 2026-06-22
- **Related:** `src/application/ports/logger.ts`, `src/application/ports/metrics.ts`, `src/application/ports/clock.ts`, `src/application/ports/config.ts`, `src/application/services/tool-invoker.ts`

## Context

This is an **MCP stdio server**: stdout/stdin carry the MCP protocol, so **anything written to stdout corrupts the protocol**. The legacy code mixed configuration reads (`process.env`, CLI parsing) and logging throughout the codebase, which both risks stdout writes and couples the rules to environment globals and a concrete logger.

We need: logging that can never touch stdout, configuration that is validated once and injected (never read ad hoc), deterministic time for testing durations, and metrics that do not bind the core to any vendor.

## Decision

Model observability and configuration as **ports**, implemented by infrastructure adapters and injected through the composition root.

- **`Logger`** — a pino-shaped structured-logging surface (`info({ ctx }, "msg")`, `child(bindings)`). The adapter writes to **stderr only**. `console` / `process.stdout` are forbidden by ESLint so stdout stays reserved for MCP. The `ToolInvoker` derives a child logger per call with `{ tool, session, client }` bindings.
- **`Config` (`AppConfig`)** — the fully-resolved, validated configuration, produced once at startup by the config adapter from env + CLI flags and injected **read-only** everywhere. **No code reads `process.env` directly.** It covers `server` (host/port — loopback by default), `session` (id/label), `logging` (level/pretty), `execution` (default timeout + thread context), `bridge` (heartbeat), and `dashboard` (enabled).
- **`Clock`** — `now()` (wall clock, for timestamps) and `monotonic()` (for durations, never goes backwards). Injecting time keeps duration logic deterministic in tests.
- **`Metrics`** — a vendor-neutral counter / histogram / gauge surface. The `ToolInvoker` emits `tool.invocations`, `tool.duration_ms` (tagged `outcome`), and `tool.errors` (tagged with the error `code`). The default adapter is a **no-op**; a real exporter is wired in at the composition root.

A `/health` endpoint on the bridge and the diagnostics tools complete the operability story.

## Consequences

**Positive**

- The MCP protocol can never be corrupted by a stray log line — stderr-only logging plus the ESLint ban make stdout writes a build-time error.
- Configuration is validated once and flows as immutable data; there is a single, testable place where env/flags are parsed.
- Deterministic `Clock` makes timing and timeout logic unit-testable without real delays.
- Metrics are instrumented at the one choke point (`ToolInvoker`) and can be exported to any backend by swapping the adapter, with zero core changes.

**Negative / costs**

- Slightly more ceremony than reading `process.env` inline: config must be threaded through constructors.
- The default no-op metrics mean nothing is emitted until an exporter is wired — observability in production is opt-in, which must be remembered when deploying.
- A logger that forgets to target stderr would be a serious bug; the adapter and lint rule must be kept honest.

## Alternatives considered

- **Log with `console` / write to stdout.** Rejected outright: it corrupts the MCP stdio protocol.
- **Read `process.env` and parse flags where needed.** Rejected: scatters configuration, defeats validation, and couples the core to globals.
- **Bind directly to a concrete vendor (Prometheus/OTel/pino) in the core.** Rejected: the ports keep the application vendor-neutral and testable; the binding belongs in an adapter at the composition root.
- **`Date.now()` directly for durations.** Rejected: non-monotonic and non-deterministic in tests; the `Clock` port's `monotonic()` is correct for elapsed-time measurement.
