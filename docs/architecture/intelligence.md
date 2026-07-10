# Intelligence layer

The Intelligence category turns the low-level executor tools into a grounded,
bounded feedback loop. It does not embed a second language model in the MCP
server. The connected AI still chooses the goal and plan; the server makes
perception, execution, verification, recovery, cleanup, and learning explicit
and machine-checkable.

## Core loop

1. `observe-world` performs one bounded breadth-first observation and creates
   session-local semantic entity handles.
2. `resolve-entity` revalidates a handle immediately before an action and can
   rediscover a stale instance from its structural fingerprint.
3. `smart-task` executes explicit steps under call, step, time, mutation, and
   loop budgets. Plan and preview modes never mutate the game.
4. `assert-state` evaluates live postconditions. A successful tool return is
   not treated as proof that the user's goal succeeded.
5. `explain-failure` classifies evidence, ranks supported fallbacks, validates
   safe corrected input, and prevents identical failed mutations from being
   repeated.
6. `state-transaction` restores explicitly captured reversible state when a
   task fails or is cancelled.

`world-delta` provides event-driven changes between observations. `teach-mode`
records a bounded demonstration and produces a conservative, reviewable
playbook rather than claiming perfect intent inference.

## Entity handles

World handles are scoped by MCP session and stored in a bounded
`getgenv().__mcp_world_brain` registry. A handle retains a weak live reference
plus a structural fingerprint. It is not a permanent identity and must be
resolved again after respawns, teleports, large hierarchy changes, or long
delays.

## Verification

Assertions return per-predicate expected/actual evidence, read errors, an
aggregate pass ratio, and conservative confidence. Missing paths, incomplete
scans, and failed reads cannot pass. Mutating workflows should declare their
success assertions before execution whenever possible.

## Recovery

Recovery output is structured as a cause, evidence, confidence, retry policy,
optional schema-validated corrected input, ranked fallback tools, and next
actions. Timeouts and transport failures are not assumed to mean that a
mutation did nothing; callers must verify live state before considering a
retry.

## Transactions

Transactions only claim support for state they captured explicitly, such as
properties, attributes, camera state, and known cleanup registries. Destroyed
instances, server-side effects, remote calls, purchases, and arbitrary game
logic are irreversible and are reported as such.

## Performance rules

- Observation scans use `GetChildren()` with hard instance and result caps.
- Delta and teaching sessions use event connections with bounded buffers.
- No Intelligence tool installs a `RenderStepped` or per-frame world scan.
- High-frequency input/property events are throttled or coalesced.
- Every observer/teaching/transaction session has explicit stop and expiry
  cleanup.
