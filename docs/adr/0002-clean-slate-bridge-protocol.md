# 2. Clean-slate bridge protocol

- **Status:** Accepted
- **Date:** 2026-06-22
- **Related:** `src/domain/protocol/messages.ts`, ADR 0001

## Context

The server talks to an in-game **connector** running inside a Roblox executor. The legacy transport accreted message types (`get-data-by-code`, ad-hoc fields) and relied on bespoke Lua-side encoding of results, with HTTP-polling and WebSocket paths both supported. The contract was asymmetric (different shapes in each direction), unversioned, and awkward to validate or debug.

For the rewrite we want a **small, explicit, versioned** wire contract that both sides speak exactly, that the transport adapter can validate at the edge, and that keeps the domain dependency-free.

## Decision

Define a single, versioned JSON envelope in the domain (`src/domain/protocol/messages.ts`) as pure data shapes:

- A `PROTOCOL_VERSION` constant (currently `1`), bumped on any breaking envelope change. The connector sends its version in `hello`.
- **Connector → server** (`ClientMessage`): `hello` (a `ClientHandshake` with identity + probed `capabilities`), `result` (an `OpResult` for a given op `id`), `event` (a channel + data), and `pong`.
- **Server → connector** (`ServerMessage`): `welcome` (server version + heartbeat interval), `op` (a `ClientOp` with an `id`), and `ping`.
- A `ClientOp` is currently `{ kind: "eval", source, threadContext, timeoutMs }` — the connector runs the Luau `source` and returns the first returned value.
- An `OpResult` is a discriminated union: `{ ok: true, value }` or `{ ok: false, error, kind?: "timeout" | "runtime" }`.

The connector serializes results as **JSON** (no bespoke Lua encoding), which keeps the contract symmetric and debuggable. The transport is WebSocket: the connector opens `ws://<BridgeURL>/bridge`. Runtime validation (zod) lives in the transport adapter, not the domain, so the domain stays pure.

## Consequences

**Positive**

- A symmetric, versioned envelope is easy to validate at the adapter boundary and easy to reason about; `request_id`/op `id` correlation is explicit (`RequestId`).
- JSON-encoded results are inspectable in logs and tests; no Lua-specific decoder to maintain.
- The capability handshake lets tools degrade gracefully on executors that lack functions like `hookfunction` or `getgc`.
- A single transport (WebSocket) removes the dual HTTP-polling/WebSocket code paths.

**Negative / costs**

- A clean-slate protocol is **not wire-compatible** with the upstream connector; a new connector script ships with the rewrite (see `connector/`, landing with the migration waves).
- Executors without WebSocket support are no longer served by an HTTP-polling fallback (a deliberate scope cut for the rewrite).
- Any breaking change to the envelope requires bumping `PROTOCOL_VERSION` and handling the mismatch in the handshake.

## Alternatives considered

- **Keep the legacy `get-data-by-code` message style.** Rejected: asymmetric, unversioned, and carries Lua-encoding baggage we are trying to drop.
- **Preserve full upstream wire compatibility.** Rejected: it would constrain the rewrite to the legacy contract's shape; the clean envelope is worth a new connector.
- **gRPC / a binary protocol.** Rejected: overkill for a loopback, single-connector bridge; JSON over WebSocket is debuggable and trivial to validate with zod.
- **Keep an HTTP-polling fallback alongside WebSocket.** Deferred: it can return as an additional adapter behind the same `ExecutionGateway` port if a target executor needs it, without changing the domain.
