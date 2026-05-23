# Tests

Unit tests for pure/near-pure logic. Playwright automation, login flows, and live system interactions are NOT tested here — they require real sessions, Duo MFA, and PII.

## Layout

`tests/unit/` mirrors `src/` one-for-one. A test for `src/foo/bar.ts` lives at `tests/unit/foo/bar.test.ts`.

```
tests/unit/
  infra/auth/      ← src/infra/auth/
  infra/browser/   ← src/infra/browser/
  services/ocr/    ← src/services/ocr/
  services/capture/ ← src/services/capture/
  services/matching/← src/services/matching/
  tracker/         ← src/tracker/
  systems/
    ucpath/        ← src/systems/ucpath/
  utils/           ← src/utils/
  workflows/
    onboarding/    ← src/workflows/onboarding/
    separations/   ← src/workflows/separations/
```

Two test files for the same source module are allowed when they test distinct behaviors (e.g. `utils/log.test.ts` + `utils/log-context.test.ts`).

`tests/integration/` is reserved for future browser-backed integration tests — do not put unit tests there.

`tests/scenarios/` holds **dashboard-contract scenario tests** for a workflow's
row lifecycle: real kernel + real tracker + real projection, scripted handler in
place of the production one. Each test snapshots `RowSnapshot` shapes via
`expect(snap).toMatchInlineSnapshot()`. Read `tests/scenarios/CLAUDE.md` before
adding scenarios for a new workflow.

## Conventions

- Framework: **vitest** for the runner (`describe`, `it`, `test`, hooks, `vi.*`) + `node:assert/strict` for assertions. We deliberately keep `node:assert/strict` rather than vitest's `expect` — both work side by side; the existing ~1800 assertion calls stay readable and the diffs vitest gives on a thrown AssertionError are still rich.
- Hook names match vitest's (`beforeAll`/`afterAll`, not `before`/`after`). Per-test cleanup uses the test-context `onTestFinished` callback: `test("...", async (t) => { t.onTestFinished(() => cleanup()) })`.
- Mocks use `vi.fn(...)` and `vi.spyOn(obj, "name").mockImplementation(...)`. Call counts read via `fn.mock.calls.length`; restore with `fn.mockRestore()`.
- Dynamic-import cache busting (re-evaluating a module after mutating `process.env` or `clear()`'ing a registry) uses `vi.resetModules()`, **not** `?case=...` query-string suffixes — vitest's Vite-backed transformer can't see a `.ts` file once a query is appended. After `vi.resetModules()`, re-import any module whose singleton state you compare against so you get the post-reset instance.
- Imports use the `.js` extension (ESM requirement): `import { x } from "../../../src/utils/foo.js"`.
- Filename mirrors the source file: `src/systems/ucpath/types.ts` → `tests/unit/systems/ucpath/types.test.ts`. Do not invent descriptive test names (`transaction-types.test.ts` was wrong — the source is `types.ts`).
- Each `describe` block covers one exported function or type.
- Prefer characterization tests for pure logic: cover documented behavior, edge cases, and any JS quirk that's been pinned (e.g. `Date.setMonth` overflow — see `workflows/separations/schema.test.ts`).
- Screenshot tests must use temp directories or per-file cleanup only. Never remove `PATHS.screenshotDir` recursively; it can contain operator audit screenshots that should survive dev-server restarts and test runs.

## Architecture tests

Static convention guards live in `tests/unit/architecture/`. Add guards when a rule is mechanical: import boundaries, default exports, signal-listener misuse, console logging outside allowed surfaces, workflow ownership leaks, and **src filename patterns** (kebab-case outside `src/dashboard/`; PascalCase components / `use*` hooks / kebab modules inside the dashboard — see `docs/engineering/codebase-conventions.md`).

## What belongs here

Pure-logic modules: schemas, date math, mapping tables, reducers, regex classifiers, worker-pool queueing, JSONL I/O, grid layout math, small string helpers.

## What does NOT belong here

- Playwright automation (`src/*/navigate.ts`, `extract.ts`, `enter.ts`)
- Auth/login flows (require Duo MFA)
- Dashboard React hooks (browser-only state + SSE)
- Excel file I/O and screenshot helpers
- CLI command scaffolding (Commander parsing)

## Running

```bash
npm test                    # Run all tests (vitest run — non-watch mode)
npm run test:watch          # Watch mode for iterative dev
npm run test:architecture   # Just the static convention guards
npm run typecheck:all       # Typecheck tests + src together
npx vitest run tests/unit/workflows/separations/schema.test.ts   # Single file
npx vitest run -t "ANNUAL_DATES"                                  # Filter by test name
```

The vitest config lives at `vitest.config.ts` (project root). It pins single-fork sequential execution to match the previous `tsx --test` behavior — several tests still rely on serial module state and shared on-disk paths under `PATHS.*`.
