# Contributing

Thanks for contributing. This project is a hexagonal (ports & adapters) rewrite, and the value of that architecture is entirely in keeping its boundaries honest. Please read the layer rules below before opening a PR — they are enforced by review and by CI.

## Setup

Requires **Node.js ≥ 20** and **pnpm** (`packageManager: pnpm@10.27.0`).

```bash
pnpm install        # install dependencies
pnpm verify         # typecheck + lint + test — run this before every push
pnpm dev            # run the composition root in watch mode (tsx)
```

Useful scripts:

| Command                                                | What it does                           |
| ------------------------------------------------------ | -------------------------------------- |
| `pnpm typecheck`                                       | `tsc --noEmit` (strict).               |
| `pnpm lint` / `pnpm lint:fix`                          | ESLint (flat config).                  |
| `pnpm format` / `pnpm format:check`                    | Prettier.                              |
| `pnpm test` / `pnpm test:watch` / `pnpm test:coverage` | Vitest.                                |
| `pnpm build`                                           | Compile to `dist/`.                    |
| `pnpm verify`                                          | typecheck + lint + test (the CI gate). |

## Layer boundaries (the one rule)

The dependency direction is strict and one-way:

> **domain ← application ← infrastructure**; **tools** depend on application + domain; the **interface** (composition root) depends on everything.

| Layer          | Path                    | May import from                                         | Must NOT import                             |
| -------------- | ----------------------- | ------------------------------------------------------- | ------------------------------------------- |
| Domain         | `src/domain/**`         | nothing                                                 | anything else                               |
| Application    | `src/application/**`    | domain                                                  | infrastructure, tools, interface            |
| Infrastructure | `src/infrastructure/**` | application, domain                                     | tools, interface, other adapters' internals |
| Tools          | `src/tools/**`          | application, domain (only the `ToolContext` at runtime) | infrastructure, the MCP SDK, the transport  |
| Interface      | `src/interface/**`      | everything                                              | —                                           |

If you find yourself importing an adapter from a use case or a tool, stop — you need a **port** (an interface in `src/application/ports/`) instead. The composition root binds the adapter to that port.

> Contract files (the domain, the ports, the tool contract, and the use-case services listed in the project brief) are **ground truth**. Don't edit them as part of a feature PR; if a contract genuinely needs to change, raise it explicitly (an ADR-level decision).

## Import rules (ESM + NodeNext)

- **Every relative import ends in `.js`** — e.g. `import { toDomainError } from "../domain/errors/errors.js";` (NodeNext resolution).
- **`verbatimModuleSyntax` is ON.** Import types with `import type { T }` (inline `import { type T }` is fine). A value-and-type import from the same module must be split.
- Use **zod v4**: `import { z } from "zod";`.

## How to add a tool

Tools are plugins authored with `defineTool` and registered centrally. They touch **only** the `ToolContext`.

1. Create a file under the right category folder in `src/tools/<category>/<name>.ts`.
2. Author it with `defineTool({ … })`:

   ```ts
   import { z } from "zod";
   import { defineTool } from "../../application/tool/define-tool.js";

   export default defineTool({
     name: "get-health",
     title: "Read a humanoid's Health",
     description: "Reads <path>.Health from the active client.",
     category: "Inspection",
     input: z.object({ path: z.string() }),
     // requiresClient defaults to true; mutatesState defaults to false
     async execute({ path }, ctx) {
       const hp = await ctx.runLuau(`return ${path}.Health`);
       return { data: { hp } };
     },
   });
   ```

3. **Register it** in `src/tools/index.ts`. Names must be unique — the `ToolRegistry` throws at boot on a duplicate.
4. Set the flags correctly:
   - `requiresClient: false` for tools that don't run on a client (diagnostics, session management). The default is `true`.
   - `mutatesState: true` for any tool that writes live game state, and say "WRITES LIVE GAME STATE" in the description.
5. Pick the `category` from the fixed set in `src/domain/tool/category.ts` (one of the 16).
6. Never resolve a client yourself, never open a socket, never call the MCP SDK. The `ToolInvoker` resolves the client and binds `ctx.runLuau` to it; that is what keeps tools testable and multi-session-safe.

Porting an existing legacy tool? Follow the authoring pattern and checklist in [docs/MIGRATION.md](docs/MIGRATION.md).

## Coding standards

- **Strict TypeScript**, including `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, and `noImplicitOverride`. `exactOptionalPropertyTypes` is off.
- **Prettier**: 100 columns, double quotes, semicolons, trailing commas, 2-space indent. Run `pnpm format` before pushing.
- **Never write to stdout.** `process.stdout` / `console.log` corrupt the MCP stdio protocol and are **banned by ESLint**. All logging goes through the injected `Logger` (which writes to stderr); pass a context object first: `logger.info({ toolName }, "invoked")`.
- **Errors cross boundaries as `DomainError`s.** Wrap adapter exceptions into the right `DomainError` subtype (or use `toDomainError`) before they escape an adapter, so the interface can map a stable `code` to a transport response. A _handled, expected_ tool-level failure can instead be returned as `{ data, isError: true }`.
- **No reading `process.env` directly.** Configuration comes from the injected `AppConfig`; env/flag parsing lives only in the config adapter.
- Comments only where they add value; meaningful names; small, focused functions.

## Tests

- Use **Vitest**. Tests live in `test/unit`, `test/integration`, with shared fakes in `test/helpers`.
- The point of the architecture is testability without I/O:
  - **Domain rules** (`resolveSelection`, the error mapping) — test with plain data.
  - **Use cases** (`ToolInvoker`, `SessionManager`) — test with fake ports and a mock `ToolContext`.
  - **Tools** — test with a mock `ToolContext`; assert the Luau you build and the decoded result. No socket, no SDK, no running game.
  - **Adapters** — focused tests against their port contract.
- New behaviour ships with tests. Bug fixes ship with a regression test.

## PR / CI checklist

Before opening a PR, confirm:

- [ ] `pnpm verify` passes locally (typecheck + lint + test).
- [ ] `pnpm format:check` passes (CI runs it too).
- [ ] No new dependency on an outer layer from an inner one; no tool imports an adapter or the SDK.
- [ ] All relative imports end in `.js`; types imported with `import type`.
- [ ] No `console` / stdout writes; logging goes through the `Logger`.
- [ ] New tools are registered in `src/tools/index.ts` with a unique name, correct `category`, and correct `requiresClient` / `mutatesState` flags.
- [ ] New behaviour has tests; contract files are untouched (or a contract change is called out explicitly).
- [ ] The `LICENSE` file's copyright notice is preserved.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, tests with coverage, and a build on **Node 20 and 22**. A PR must be green on all of them.
