# Tests

Unit tests for pure/near-pure logic. Playwright automation, login flows, and live system interactions are NOT tested here — they require real sessions, Duo MFA, and PII.

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

## Lessons Learned

- **2026-05-27: Architecture guards should avoid shell-only tool assumptions.** The origin-workflow lineage guard now scans with Node filesystem APIs instead of spawning `rg`, because Codex sessions can expose ripgrep through a shell path that is not executable from Vitest's `spawnSync`.

## What belongs here

Pure-logic modules: schemas, date math, mapping tables, reducers, regex classifiers, worker-pool queueing, JSONL I/O, grid layout math, small string helpers.

## What does NOT belong here

- Playwright automation (`src/*/navigate.ts`, `extract.ts`, `enter.ts`)
- Auth/login flows (require Duo MFA)
- Dashboard React hooks (browser-only state + SSE)
- Excel file I/O and screenshot helpers
- CLI command scaffolding (Commander parsing)

## Stderr audit

`tests/log-audit.ts` is loaded via `vitest.config.ts` + `setupFiles`. After each
test, any stderr line outside the allowlist in that file fails the run (intentional
`✗` error-path logs, the SSE malformed-envelope test, and the invalid-PDF fixture
in `render-pages.test.ts` only). Fix root causes rather than widening the list.

## Running

```bash
npm test                    # Run all tests (dot reporter — live progress, quiet on pass)
npm run test:verbose        # Per-test pass/fail lines (best for one file or -t filter)
npm run test:watch          # Watch mode for iterative dev
npm run test:architecture   # Just the static convention guards
npm run typecheck:all       # Typecheck tests + src together
npx vitest run tests/unit/workflows/separations/schema.test.ts --reporter=verbose   # Single file
npx vitest run -t "ANNUAL_DATES" --reporter=verbose                                  # Filter by test name
```

### Stderr audit (every `npm test`)

`tests/log-audit.ts` is a vitest setup file. After each test it fails if **stderr** contains a line that is not on the allowlist in `tests/log-audit-core.ts`. The hook captures both `console.*` (via vitest `onConsoleLog`) and direct `process.stderr.write` (pdfjs and similar).

- Intentional `log.error` lines in failure-path tests usually start with `✗ ` and are allowlisted.
- Add a new allowlist entry only when a test **must** emit stderr and you have a matching assertion on the outcome.
- Benign pdfjs `Warning: Indexing all PDF objects` is ignored; the contract is `renderPdfPagesToPngs` returning page files (see `tests/unit/workflows/ocr/orchestrator.test.ts` `setup()`).

The vitest config lives at `vitest.config.ts` (project root). It pins single-fork sequential execution to match the previous `tsx --test` behavior — several tests still rely on serial module state and shared on-disk paths under `PATHS.*`.
