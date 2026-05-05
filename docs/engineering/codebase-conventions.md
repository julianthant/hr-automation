# HR Automation Codebase Conventions

This document is the source of truth for naming, ownership, and review rules.
`CLAUDE.md` and `AGENTS.md` files should point here and repeat only the
module-specific parts.

## Module Ownership

- `src/core/`: workflow kernel, run modes, `Ctx`, task/control contracts, and cancellation primitives. Cross-workflow execution behavior starts here.
- `src/systems/`: browser drivers for external systems. Playwright selectors and navigation helpers belong here, not in workflows.
- `src/workflows/`: orchestration only. Workflow folders own schema, step composition, CLI adapter, and workflow-specific business decisions.
- `src/domain/`: shared pure/domain behavior used across workflows, tracker, dashboard, OCR, or core.
- `src/ocr/forms/`: OCR form specs and shared OCR schemas. OCR orchestration must not import form specs from downstream workflow folders.
- `src/tracker/`: JSONL/session/event persistence and dashboard backend APIs.
- `src/dashboard/`: React operator UI. It renders backend metadata and should not re-invent workflow business rules.
- `tests/unit/`: mirrors `src/` and guards pure logic, architecture boundaries, and regression-prone helpers.

If code is used by two workflows, or one workflow plus tracker/dashboard/core/OCR, promote it out of `src/workflows/<workflow>/`.

## Naming

- Files and directories use kebab-case: `person-org-summary.ts`, `task-control.ts`.
- Types, interfaces, classes, and Zod schemas use PascalCase. Zod schemas end in `Schema`; inferred types usually use the same name without `Schema`.
- Workflow ids are stable kebab-case strings and should not encode delegation. Use task role metadata for `root`, `delegator`, `child`, `utility`, or `approval`.
- Functions use action-oriented names:
  - `parseX` converts text into structured parts and may throw on invalid syntax.
  - `normalizeX` returns a comparison/storage-safe value.
  - `displayX` or `formatX` returns operator-facing text.
  - `deriveX` computes a deterministic value from input.
  - `resolveX` chooses the best value from multiple possible sources.
  - `buildX` constructs a plain object or plan without side effects.
  - `createX` constructs a stateful object, handler, server, or store.
  - `readX`, `writeX`, `listX`, and `findX` perform persistence or lookup.
  - `isX`, `hasX`, `canX`, and `shouldX` return booleans.
  - `ensureX` performs a side effect to make a condition true or throws.
  - `assertX` validates an invariant and throws if false.
  - `runX` executes a workflow or top-level process.
- Avoid vague names such as `handleThing`, `processData`, `doWork`, `helper`, or `utils` unless the surrounding API makes the action specific.

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
- Shared fixes belong in `src/core`, `src/domain`, `src/systems`, or `src/ocr/forms` before workflow-local helpers.
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
