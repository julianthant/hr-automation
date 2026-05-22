# HR Automation Codebase Conventions

This document is the source of truth for naming, ownership, and review rules.
Root and module `CLAUDE.md` files should point here and repeat only the
module-specific parts. For what counts as maintained docs versus ephemeral agent output, see `docs/README.md`.

## Module Ownership

- `src/core/`: workflow kernel, run modes, `Ctx`, task/control contracts, and cancellation primitives. Cross-workflow execution behavior starts here.
- `src/systems/`: browser drivers for external systems. Playwright selectors and navigation helpers belong here, not in workflows.
- `src/workflows/`: orchestration only. Workflow folders own schema, step composition, CLI adapter, and workflow-specific business decisions.
- `src/domain/`: shared pure/domain behavior used across workflows, tracker, dashboard, OCR, or core.
- `src/infra/`: runtime infrastructure such as auth, Duo/SSO helpers, and browser launch/session primitives.
- `src/services/`: reusable stateful or IO-backed capabilities such as capture, OCR, and roster matching.
- `src/services/ocr/forms/`: OCR form specs and shared OCR schemas. OCR orchestration must not import form specs from downstream workflow folders.
- `src/services/matching/`: roster loading plus name/address/EID matching. Pure matching can be split into `src/domain/matching/` when it no longer depends on IO or LLM disambiguation.
- `src/tracker/`: JSONL/session/event persistence and dashboard backend APIs.
- `src/dashboard/`: React operator UI. It renders backend metadata and should not re-invent workflow business rules.
- `tests/unit/`: mirrors `src/` and guards pure logic, architecture boundaries, and regression-prone helpers.

If code is used by two workflows, or one workflow plus tracker/dashboard/core/OCR, promote it out of `src/workflows/<workflow>/`.

## Naming

### Paths and directories

- Under `src/` **outside** `src/dashboard/`, all directories and `.ts` files use **kebab-case** only (e.g. `person-org-summary.ts`, `task-control.ts`). `.tsx` under `src/` today lives under `src/dashboard/` only.
- **Tests** mirror those paths: `tests/unit/<mirrored-path>.test.ts` (see `tests/CLAUDE.md`).

### Dashboard (`src/dashboard/`) file names

The SPA follows typical React patterns; file names may be:

| Pattern | Example | Use for |
|--------|---------|--------|
| **PascalCase** + `.tsx` | `QueuePanel.tsx` | Components that render JSX |
| **`use` + PascalCase** + `.ts` / `.tsx` | `useEntries.ts`, `useBatchQueueContext.tsx` | Hooks (no JSX or rare JSX — prefer `.ts` when no JSX) |
| **kebab-case** + `.ts` / `.tsx` | `batch-queue-view.tsx`, `entry-display.ts`, `workflows-context.tsx` | Multi-export modules, small views, context providers, pure helpers co-located with UI |

Exception: **`src/dashboard/lib/utils.ts`** is the Tailwind/shadcn-style **`cn()`** home and may hold one or two tiny cross-cutting browser helpers (e.g. `dateLocal`) that are not worth splitting. Do not turn it into a junk drawer; domain logic stays in `src/domain/` or feature modules.

### File stems by role (kernel, tracker, workflows)

Use consistent stems so imports hint at responsibility:

| Stem / pattern | Typical location | Contents |
|----------------|------------------|----------|
| `schema.ts` | workflow folder | Zod `*Schema` + inferred input types |
| `workflow.ts` | workflow folder | `defineWorkflow(...)` export |
| `config.ts` | workflow folder | workflow-local constants / env re-exports |
| `index.ts` | workflow folder | public exports for composition |
| `orchestrator.ts`, `prepare.ts`, `approve.ts` | workflow or `tracker/.../ocr/` | multi-step coordinators or HTTP-backed phases |
| `*-http.ts`, `routes/*.ts` | `src/tracker/` | HTTP handlers, Hono route modules |
| `selectors.ts` | `src/systems/<sys>/` | Playwright selector registry |
| `navigate.ts`, `extract.ts`, `transaction.ts` | `src/systems/<sys>/` | grouped driver verbs (existing convention) |
| `types.ts` | anywhere | shared interfaces for that folder |
| `build*Handler` factories | `src/tracker/dashboard/`, `src/workflows/*/handler.ts` | **return** route handlers or `() => Response` closures (see Functions below) |

Avoid new catch-all names such as `helpers.ts` or `misc.ts`. Prefer a **verb or domain noun** in kebab-case (`delegation-row-helpers.ts`, `tracker-terminal-display.ts`).

### Types, classes, and schemas

- Types, interfaces, and classes use **PascalCase**.
- Zod schemas end with **`Schema`**; the inferred type is usually the same name without `Schema` (e.g. `export type Foo = z.infer<typeof FooSchema>`).
- Workflow ids are stable **kebab-case** strings and should not encode delegation. Use task role metadata for `root`, `delegator`, `child`, `utility`, or `approval`.

### Functions and methods

- Functions use **action-oriented** names:
  - `parseX` converts text into structured parts and may throw on invalid syntax.
  - `normalizeX` returns a comparison/storage-safe value.
  - `displayX` or `formatX` returns operator-facing text.
  - `deriveX` computes a deterministic value from input.
  - `resolveX` chooses the best value from multiple possible sources.
  - `buildX` constructs a plain object or plan without side effects.
  - **`buildXHandler`** returns a dashboard/HTTP handler closure (see below); **`createX`** constructs other stateful objects (servers, stores, long-lived clients).
  - `readX`, `writeX`, `listX`, and `findX` perform persistence or lookup.
  - `isX`, `hasX`, `canX`, and `shouldX` return booleans.
  - `ensureX` performs a side effect to make a condition true or throws.
  - `assertX` validates an invariant and throws if false.
  - `runX` executes a workflow or top-level process (CLI entrypoints, orchestrators).
- **HTTP / dashboard handlers:** prefer **`buildOcrPrepareHandler`**, **`buildDeleteEntryHandler`**, etc. Inner functions that map directly to a single verb+noun may use **`handleUpload`**, **`handleManifest`** when the name is specific (not `handleRequest`).
- Avoid vague names such as `processData`, `doWork`, or `helper` unless the scope is tiny and local.

### Enforcement

- **Default exports**, **`console.*`** in server workflows, and **workflow import boundaries** are checked in `tests/unit/architecture/`.
- **Kebab-case paths** under `src/` excluding `src/dashboard/` (and dashboard’s React/hook patterns above) are checked in `tests/unit/architecture/code-conventions.test.ts`.

## Exports And Imports

- Prefer named exports. Do not add default exports in `src/`; dashboard React entrypoints are the only current exception.
- Include `.js` extensions in TypeScript ESM imports.
- Do not import internal files across workflow folders. Import workflow entrypoints only when composing workflows intentionally.
- Avoid broad barrels for domain modules unless they preserve a stable public surface.

## Logging And Notifications

- Use `log.step/success/warn/error/waiting/debug`; do not use `console.log` in production `src/` modules outside explicit CLI/script surfaces.
- Structured logs must keep a readable `message` and add fields such as `category`, `occasion`, `subject`, `system`, `step`, `attempt`, `childWorkflow`, or `durationMs` when useful.
- Operator-facing notifications must use `data.__subject` or the shared operator subject resolver first. Run ids and session ids are debug details, not primary text.
- Telegram messages should be routed by notification policy, not emitted ad hoc from workflow handlers.

## Playwright And Selectors

- System selectors live in `src/systems/<system>/selectors.ts` and generated `SELECTORS.md`.
- Do not inline `page.locator(...)` in system/workflow files except where the existing inline-selector guard allows it with a documented comment.
- Use `safeClick` and `safeFill` for selector registry calls where fallback behavior matters.
- UCPath PeopleSoft iframe work should use shared UCPath navigation helpers.

## Workflow Rules

- New workflows use `defineWorkflow`.
- Every workflow declares `operatorSubject`, `detailFields`, `getName`, and `getId`.
- Every workflow seeds pending-row display data through `initialData` or `operatorSubject`.
- Shared fixes belong in `src/core`, `src/domain`, `src/systems`, `src/services`, or `src/infra` before workflow-local helpers.
- Before adding a workflow-local helper, ask: "Would another workflow need this when it grows?" If yes, promote it now.

## Errors And Cancellation

- Throw typed/domain errors where callers branch on behavior; otherwise throw normal `Error` with actionable messages.
- Use `classifyError`/`errorMessage` at boundaries that render errors to logs or tracker rows.
- Do not swallow errors unless the action is explicitly best-effort; best-effort catches must log or comment why failure is non-fatal.
- Check cancellation at step boundaries, inside long waits, and before irreversible submit/save actions once the shared cancellation API exists.

## Tests

- Use `node:test` and `node:assert/strict`.
- Unit tests mirror `src/` paths.
- Shared primitives need focused tests before migration.
- Architecture conventions that can be checked statically should have tests in `tests/unit/architecture/`.
- Every bug fix gets a regression test unless the behavior requires live Duo/browser/PII; document that exception in the commit or plan.

## Node 26 Conventions

Floor: Node 26.0.0 (pinned via `engines` + `.nvmrc`). Prefer the Node 26 primitives below over older equivalents in new code. Do **not** codemod existing working code for aesthetic reasons — adopt these as files are touched.

| Use this | Instead of | When |
|---|---|---|
| `Promise.withResolvers()` | `let resolve, reject; const p = new Promise((r, j) => { resolve = r; reject = j; })` | Building deferred promises (event handlers, lazy gates) |
| `Array.fromAsync(asyncIter)` | `const out = []; for await (const x of iter) out.push(x); return out;` | Materializing an async iterable |
| Iterator helpers (`.map/.filter/.take/.drop/.flatMap`) | `[...iter].map(...)` / `Array.from(iter).filter(...)` | Streaming transforms where you don't need the full array materialized |
| `AbortSignal.timeout(ms)` | `const c = new AbortController(); setTimeout(() => c.abort(), ms);` | Fetch / cancellation timeouts |
| `AbortSignal.any([a, b])` | Manual `addEventListener("abort", ...)` chaining | Composing multiple signals |
| `node:timers/promises` `setTimeout(ms, value, { signal })` | Hand-rolled abortable sleep | Sleep that should reject on abort |
| `import.meta.dirname` | `fileURLToPath(import.meta.url)` + `dirname()` | `__dirname` equivalent in ESM |
| `styleText("red", s)` from `node:util` | `chalk.red(s)` / `pc.red(s)` | Colored CLI output |
| `node:sqlite` (via `src/infra/sqlite/` shim) | `better-sqlite3` | Any SQLite — project default |
| `Object.groupBy(iter, fn)` | Reduce-into-accumulator | Bucketing items by key |
| `node:util.parseArgs` | `commander` (for **new internal scripts only**) | Tiny scripts in `src/scripts/` that don't need commander's subcommand tree |

**Type-stripping note:** The codebase uses `tsx` for runtime TS execution. Native `node --strip-types` is intentionally NOT used because the codebase imports relative paths with `.js` extensions and Node 26's strip-types mode does not rewrite `.js` → `.ts`. Migrating to native execution would require rewriting every relative import — rejected for a marginal cold-start win. If `tsx` ever drops support, revisit then.

### Sandboxing (optional)

Node 26's permission model can sandbox daemon processes so a Playwright bug or rogue selector cannot write outside expected paths. Disabled by default — the threat model for an internal HR tool running on operator machines doesn't justify the operational cost (every new write path becomes an allowlist edit).

To enable for a specific deployment, launch daemons with:

```bash
node --permission \
  --allow-fs-read=* \
  --allow-fs-write=/Users/$USER/Documents/hr-automation/.tracker \
  --allow-fs-write=/Users/$USER/Documents/hr-automation/.screenshots \
  --allow-fs-write=/tmp \
  --allow-child-process \
  ./node_modules/.bin/tsx --env-file=.env src/cli-daemon.ts <workflow>
```

Required flags:
- `--allow-fs-read=*` — Playwright reads from many paths (Chromium binaries, user-data-dir, system fonts).
- `--allow-fs-write=<tracker dir>` — JSONL emissions, SQLite state DB, screenshot uploads.
- `--allow-fs-write=<screenshots dir>` — debug screenshots written by `Stepper.step` on failure.
- `--allow-fs-write=/tmp` — Playwright + Chromium temp files.
- `--allow-child-process` — Playwright spawns Chromium.

Network access does not need a flag (allowed by default in the permission model).
