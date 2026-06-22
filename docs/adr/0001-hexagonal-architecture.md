# 1. Hexagonal architecture (ports & adapters)

- **Status:** Accepted
- **Date:** 2026-06-22
- **Supersedes:** the legacy layout in `_legacy/src/**` (bridge handlers, HTTP routes, and tools coupled to a global registry and transport)

## Context

The upstream implementation (preserved under `_legacy/`) grew organically. Tools reached directly into transport helpers (`sendAndWait`, `resolveDispatchClientId`), session and client selection lived in module-level singletons, and HTTP/WebSocket/MCP concerns were interleaved with business logic. That makes the rules hard to test without standing up a socket and an SDK, and hard to change without rippling across the codebase.

We are rewriting from scratch and want the rules — client selection, session isolation, the error taxonomy, the tool lifecycle — to be **pure and testable**, with every side effect isolated behind a replaceable boundary.

## Decision

Adopt a **hexagonal (ports & adapters)** architecture with a strict, one-way dependency rule:

> **domain ← application ← infrastructure**; **tools** depend on application + domain; the **interface** (composition root) depends on everything.

- `src/domain/**` — pure types and rules, zero dependencies (`ids`, `errors`, `protocol`, `client`/`selection`/`session`, `tool/category`).
- `src/application/**` — **ports** (interfaces the outside must implement), **use-case services** (`ToolInvoker`, `SessionManager`), and the **tool contract** (`Tool`, `ToolContext`, `defineTool`, `ToolRegistry`). Depends only on domain.
- `src/infrastructure/**` — adapters that implement the ports (WebSocket bridge, MCP stdio, pino logger, config loader, metrics, session store).
- `src/tools/**` — `defineTool` plugins that touch only the `ToolContext`.
- `src/interface/**` — the composition root that wires concrete adapters to ports.

The rule is enforced by convention, by the directory structure, and by the fact that nothing in `domain`/`application` imports from `infrastructure`. ESM + NodeNext (`.js` import suffixes) and `verbatimModuleSyntax` keep imports explicit.

## Consequences

**Positive**

- The core is unit-testable with fakes — `resolveSelection`, `ToolInvoker`, and `SessionManager` need no socket, SDK, or running game.
- Adapters are swappable: the in-memory `SessionStore` can become durable, the no-op `Metrics` can become a real exporter, without touching a use case.
- Tools are tiny and uniform because the whole call lifecycle (validate, resolve client, time, log, normalize errors) lives once in `ToolInvoker`.
- The dependency direction makes accidental coupling obvious in review (a domain file importing an adapter is an immediate smell).

**Negative / costs**

- More indirection up front: a port + an adapter where the legacy code had a single helper.
- Discipline required — the import rules and `.js` suffixes are easy to get wrong; CI (typecheck + lint) backstops this.
- The legacy 176-tool catalog cannot be lifted wholesale; it must be ported wave by wave onto the new contract (see ADR 0003 and `docs/MIGRATION.md`).

## Alternatives considered

- **Keep the legacy layered-but-coupled structure.** Rejected: the coupling to transport and global state is exactly what made the rules untestable and change-resistant.
- **A traditional N-tier (controllers → services → repositories) layout.** Rejected: it still tends to let infrastructure types (the SDK, the socket) leak inward; hexagonal's explicit ports make the boundary harder to violate by accident.
- **A framework (e.g. NestJS) with built-in DI.** Rejected: heavyweight for a single-process MCP server; we want a minimal dependency surface and an explicit composition root rather than a DI container's runtime magic.
