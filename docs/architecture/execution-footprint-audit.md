# Execution-footprint audit

`execution-footprint-audit` is a target-aware, read-only Luau inspection tool. It answers a narrower and more honest
question than "is this script detected?": which locally observable execution footprints exist, which findings are
confirmed versus heuristic, which checks were unavailable, and how much of the requested audit completed.

It does not bypass, disable, hook, spoof, or conceal anything. A clean report is not proof that a server, game script,
or external anti-cheat has not detected an action.

## Targets

The tool can inspect a script path, a function expression, both, or neither. A script target enables script identity,
environment, closure, and bounded source checks. A function target enables closure identity, hook, hash, constants,
upvalue-shape, and environment checks. With no target it reports only the current executor/auditor environment and
virtual-input provenance.

Target functions are inspected but never invoked. Script closures are obtained only through guarded runtime
reflection when the executor supports it.

## Audit matrix

- **Virtual input:** inventories [Volt-compatible mouse and keyboard primitives](https://docs.voltbz.net/docs/input)
  plus Roblox [virtual-input services](https://create.roblox.com/docs/reference/engine/classes/VirtualInputManager),
  classifies callable provenance, and compares callable identity/hash against retained MCP closure handles.
- **Environment exposure:** inventories bounded key names from target and current environments, checks privileged
  executor names, reports shared environment identities, and inspects a bounded number of current stack frames.
- **Script identity:** reports guarded script paths, calling-script observations, script hashes,
  [Volt script-reflection](https://docs.voltbz.net/docs/scripts) metadata, and
  accessible source indicators.
- **Closure integrity:** reports C/L/executor/new-C classifications, hook state, function hash, debug source/line, bounded
  string constants, and upvalue names or types without serializing captured values.
- **Static indicators:** scans only a bounded source prefix for virtual-input, environment, debug, and hook names. It
  does not decompile missing source.
- **Runtime telemetry:** reports elapsed time, configured budgets, unavailable checks, and every truncation condition.

Capability availability alone is informational. A finding requires observable target exposure or use evidence.
`isexecutorclosure` also classifies functions created by an executor-hosted user script, so that result is provenance,
not a detection verdict.

## Retained closure references

Input functions are compared with `getgenv().__mcp_closure_refs` by identity and, where available, function hash. A
match means only that the MCP retained a corresponding handle. A clone or retained-reference match does not make input
undetectable and does not reduce risk by itself. A missing match is reported as provenance evidence, not as proof that
an anti-cheat observed it.

## `getfenv` and target environments

`getsenv(script)` inspects the selected script environment. `getfenv(level)` can only describe the auditor's current
bounded call stack unless the audited function is actually running; the tool never invokes that function, so it keeps
those observations separate.

Luau [deprecates `getfenv`/`setfenv`](https://rfcs.luau.org/deprecate-getfenv-setfenv.html), and even reading through
`getfenv` can deoptimize an environment. The report calls
this out explicitly and keeps stack probing optional and bounded.

## Privacy and boundedness

The tool returns environment key names, upvalue names/types, bounded string indicators, and metadata. It never returns
environment values, upvalue values, registry contents, tokens, cookies, request headers, or arbitrary table payloads.

The implementation performs one Luau call, has no descendant or GC-wide scan, installs no connection or hook, runs no
frame loop, sends no input, and never calls the target closure. Evidence, stack, source, constant, upvalue, environment,
and retained-reference work is capped; truncation is explicit rather than silent.

Default budgets are 100 combined finding/evidence records, 8 current stack frames, 120 keys per unique environment,
60,000 source characters, 96 constants, 64 upvalues, and 120 retained closure handles. Inputs can lower those limits;
hard schema and execution clamps prevent callers that bypass schema parsing from exceeding the maximums.

## Agent workflow

For goals mentioning script detection, virtual-input provenance, executor fingerprints, closure exposure, or
`getfenv` leaks, `tool-plan` selects `execution-footprint-audit` first. `get-anticheat-surfaces` is an optional second
read that adds lightweight ambient context; neither tool should be interpreted as a detection verdict.
