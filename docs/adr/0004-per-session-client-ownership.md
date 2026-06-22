# 4. Per-session client ownership

- **Status:** Accepted
- **Date:** 2026-06-22
- **Related:** `src/domain/client/selection.ts`, `src/domain/client/session.ts`, `src/application/services/session-manager.ts`, `src/application/ports/session-store.ts`

## Context

A single server may have **several Roblox clients connected at once**, and a user may run **two AI sessions** (e.g. two Claude windows) that each want to drive a _different_ game. Two failure modes must be avoided:

1. A session silently driving the wrong game when more than one client is connected.
2. A reconnect breaking a session's binding — a Roblox client gets a **new `ClientId` on every rejoin**, even though the underlying account (`UserId`) is stable.

The legacy code held active selection in module-level singletons, which conflates the two sessions' state and makes the resolution rules hard to test.

## Decision

Make client selection **per session**, resolved by a single **pure** rule.

- Each `Session` owns its own `ClientSelection` (`{ clientId?, userId?, username? }`). The `SessionStore` port keys sessions by `SessionId`; the default adapter is in-memory but the port allows a durable store later.
- `resolveSelection(selection, clients)` (in the domain) is side-effect-free and resolves in this order:
  1. exact `clientId`, if still connected;
  2. account match (`userId` / `username`), **sticky across reconnects** — newest socket wins if duplicated;
  3. no selection + exactly one connected account → that client;
  4. no selection + multiple distinct accounts → `ambiguous`;
  5. nothing connected → `none`.
- `SessionManager.requireActiveClient` turns a non-`resolved` outcome into the precise domain error — `AmbiguousClientError` (carrying the candidate accounts) or `NoClientSelectedError` (distinguishing "no clients" from "your pinned client is offline"). The server **refuses to guess** when accounts are ambiguous.
- The `ToolInvoker` calls this before any client-bound tool runs and binds `ctx.runLuau` to the resolved client, so a tool physically cannot reach another session's game.

Binding by **`username`/`userId` is recommended** because it is account-sticky: when the account rejoins under a new `ClientId`, the session keeps targeting it with no re-selection.

## Consequences

**Positive**

- Two sessions drive two games with strong isolation; neither can clobber the other's selection.
- Account-sticky selection survives rejoins transparently — no manual re-binding after a server hop.
- The resolution rule is pure and exhaustively unit-testable (every branch is reachable with plain data).
- Ambiguity produces a clear, actionable error instead of a silent wrong-target execution.

**Negative / costs**

- The default in-memory store means selection is process-scoped and lost on restart (acceptable; a durable adapter can be added behind the port).
- Account-stickiness needs identity from the handshake (`userId`/`username`); a fully anonymous connector can only be pinned by the ephemeral `clientId`, which breaks on rejoin (a fundamental limitation, not a design flaw).

## Alternatives considered

- **Global active client (legacy singleton).** Rejected: cannot support two isolated sessions and conflates their state.
- **Pin only by `clientId`.** Rejected: breaks on every rejoin because the id is ephemeral; account stickiness is the whole point.
- **Auto-pick the newest client on ambiguity.** Rejected: silently driving the wrong game is the exact hazard this design exists to prevent — ambiguity must be surfaced, not guessed.
- **Stateful selection objects with embedded I/O.** Rejected: keeping `resolveSelection` pure is what makes the multi-session logic testable; side effects live in `SessionManager`/the store.
