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

`code-conventions.test.ts` also enforces: **no `.tsx` outside `src/dashboard/`**, **no `AGENTS.md` under `src/`** (the repo-root `AGENTS.md` session artifact is exempt), and a broadened **console guard** matching `console.\w+` (table/dir/trace/group/…), not just log/warn/error/info/debug — keep the allowlist tight (`render-pages.ts` monkey-patches `console.warn` to mute pdfjs and is allowlisted). `runtime-policy-coverage.test.ts` side-effect-imports every workflow including `i9-lookup`; when adding a workflow, add its import there or its action descriptors go unvalidated.

## Tier-1 delegation pool (`tests/delegation/`, CI-able)

Deterministic tests that prove the dashboard projection stays correct under delegation, concurrency, and cancellation — driven through the **real daemon** against a temp tracker root (no live browser, no real `.tracker/`). No separate vitest pool needed: the main `tests/**/*.test.ts` glob already picks them up, so they run in `npm test` automatically.

The harness foundation lives in `tests/delegation/_runtime/` (projection tooling `snapshot-row.ts` + the daemon harness; see `tests/delegation/_runtime/CLAUDE.md`).

## Mocked-integration pool (`tests/integration/`, transitional)

Real kernel + real handlers + stubbed Playwright. Migration state:

| Status | File | Why it stays / when it goes |
|--------|------|-----------------------------|
| **Keep (permanent)** | `core/mock-workflow.test.ts` | Parallel-staggered auth-gating order — logins complete before `ctx.page()` resolves; no Tier-1 equivalent planned |
| **Keep (permanent)** | `oath-upload-smoke.test.ts` | Real `oathUploadHandler` happy path via escape hatches |
| **Keep (permanent)** | `oath-upload-extended.test.ts` | Real handler: `skipStep` upload-only + idempotency/ticket reuse |
| **Bridge** | `ocr/end-to-end.test.ts` | Delete when Tier-1 P2.9 (OCR→oath-signature fan-out through real daemon) is green |
| **Bridge** | `delegation-parentrunid.test.ts` | Delete when Tier-1 P2.9 (parentRunId/archetype/traceId on real fan-out) is green; also unit-covered by `ctx-delegate-to*.test.ts` |
| **Bridge** | `retry-original-input.test.ts` | Delete when a Tier-1 test asserts retry-after-cancel; also unit-covered by `retry-uses-original-input.test.ts` |
| **Removed (Phase 0)** | `batch-fanout.test.ts` | Legacy in-process `runWorkflowBatch/Pool`; daemon never uses it; unit-covered |

**Rule:** delete each bridge only after its Tier-1 superseder is green — coverage must never dip.

## Live integration pool (`tests/live/`, opt-in)

Real end-to-end tests that hit **live UCSD systems** with a real Chromium and hands-off Duo (CDP WebAuthn). They run in a **separate pool** via `vitest.live.config.ts` (`npm run test:live`) and are **excluded from `npm test`** (`vitest.config.ts` excludes `tests/live/**`). They are the only layer that catches live SSO/DOM drift — unit/Tier-1-delegation/mocked-integration can't.

Rules (these mirror the hard realities of live testing):
- **Opt-in, never CI.** Require `.env` creds + `.auth/duo-webauthn.json` (the enrolled WebAuthn key) + a machine that can run Chromium. Each test **skips cleanly** (precondition guard) when those are absent — never fail/hang on a fresh clone.
- **Serial, clean teardown.** Duo signCount is global server state; the pool is single-fork. Never force-kill mid-ceremony (desyncs signCount → next run rejected as a clone; resync via the one-liner in `docs/engineering/hands-off-duo-webauthn.md` §6).
- **No dashboard pollution.** Workflow e2e (later) drives `runOneItem` with the tracker pointed at a `mkdtemp` dir — rows never touch `.tracker/`, so nothing shows in the dashboard. Auth smoke emits no rows at all.
- **Non-mutating.** Auth smoke lands read-only. Workflow e2e runs in **dry-run** (no Save/Submit) — see `docs/engineering/hands-off-duo-webauthn.md` and the workflow `dryRun` flags.
- **Hands-off setup** lives in `tests/live/_setup.ts` (loads real `.env`, sets `HR_AUTOMATION_DUO_WEBAUTHN=1`). NO log-audit setup — live auth logs to stderr legitimately. Headless by default; `HR_TEST_HEADED=1` to watch.
- **Flow list is shared.** The six SSO flows come from `src/infra/auth/duo-login-flows.ts` (one source of truth with the `test-login` CLI) — add a 7th flow there and it's covered everywhere.

## Regression clusters

- Dashboard queue/rail counts: backend `wfCounts` regressions belong in `tests/unit/tracker/state-queries.test.ts` and pure count helpers under `tests/unit/tracker/` or `tests/unit/dashboard/`. Pin that counts are backend-authoritative, independent of the selected workflow, and use the same queue-surface model as the rendered rail badges. OCR prep rows that still render in the queue must remain counted until the queue no longer renders them.
- Person lookup dates: tests under `tests/unit/workflows/person-lookup/` should keep UCPath Last Hire/startDate separate from assignment EFFDT/effectiveDate. Dashboard detail fields should show `startDate`; retain `effdt` only as backend context.
- Workflow categories/start surfaces: when a workflow moves category or start-surface eligibility, pin both the workflow config and the loader/surface arrays. Example: delegated utilities such as `i9-lookup` are `category: "Utils"` but are not dashboard input/upload starts.

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
npm run test:live           # Live e2e: real browser + live UCSD SSO + hands-off Duo (opt-in; skips without creds)
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
