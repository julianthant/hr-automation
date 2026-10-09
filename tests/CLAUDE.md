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

`code-conventions.test.ts` also enforces: **no `.tsx` outside `src/dashboard/`** and a broadened **console guard** matching `console.\w+` (table/dir/trace/group/…), not just log/warn/error/info/debug — keep the allowlist tight (`render-pages.ts` monkey-patches `console.warn` to mute pdfjs and is allowlisted). `runtime-policy-coverage.test.ts` side-effect-imports every workflow including `i9-lookup`; when adding a workflow, add its import there or its action descriptors go unvalidated.

## Tier-1 delegation pool (`tests/delegation/`, CI-able)

Deterministic tests that prove the dashboard projection stays correct under delegation, concurrency, and cancellation — driven through the **real daemon** against a temp tracker root (no live browser, no real `.tracker/`). No separate vitest pool needed: the main `tests/**/*.test.ts` glob already picks them up, so they run in `npm test` automatically.

The harness foundation lives in `tests/delegation/_runtime/` (projection tooling `snapshot-row.ts` + the daemon harness; see `tests/delegation/_runtime/CLAUDE.md`).

## Mocked-integration pool (`tests/integration/`, transitional)

Real kernel + real handlers + stubbed Playwright. Migration state:

| Status | File | Why it stays / when it goes |
|--------|------|-----------------------------|
| **Keep (permanent)** | `core/mock-workflow.test.ts` | Parallel-staggered auth-gating order — logins complete before `ctx.page()` resolves; no Tier-1 equivalent planned |
| **Keep (permanent)** | `oath-upload-smoke.test.ts` | Real `oathUploadHandler` happy path via escape hatches. **NOT superseded by P2.12** — `tests/delegation/ocr-oath-upload.test.ts` asserts the `approveDocumentTo` ticket-row PROJECTION (a gated stub files no ticket); this asserts the real handler/ticket logic. |
| **Keep (permanent)** | `oath-upload-extended.test.ts` | Real handler: `skipStep` upload-only + idempotency/ticket reuse. **NOT superseded by P2.12** (same reason — projection vs real ticket logic). |
| **Bridge** | `retry-original-input.test.ts` | Delete when a Tier-1 test asserts retry-after-cancel; also unit-covered by `retry-uses-original-input.test.ts`. **Still kept** — P2.9–P2.12 do not assert retry-after-cancel (a later task owns it). |
| **Removed (P2.9)** | `ocr/end-to-end.test.ts` | Superseded by `tests/delegation/ocr-oath-signature.test.ts` (OCR→oath-signature fan-out through the real daemon). Its real-orchestrator wiring lives in `tests/delegation/_runtime/ocr-stub.ts`. |
| **Removed (P2.9)** | `delegation-parentrunid.test.ts` | parentRunId/archetype/traceId on a real fan-out are now asserted by `tests/delegation/ocr-oath-signature.test.ts`; also unit-covered by `ctx-delegate-to*.test.ts`. |
| **Removed (Phase 0)** | `batch-fanout.test.ts` | Legacy in-process `runWorkflowBatch/Pool`; daemon never uses it; unit-covered |

**Rule:** delete each bridge only after its Tier-1 superseder is green — coverage must never dip.

## Live integration pool (`tests/live/`, opt-in)

Real end-to-end tests that hit **live UCSD systems** with a real Chromium and hands-off Duo (CDP WebAuthn). They run in a **separate pool** via `vitest.live.config.ts` (`npm run test:live`) and are **excluded from `npm test`** (`vitest.config.ts` excludes `tests/live/**`). They are the only layer that catches live SSO/DOM drift — unit/Tier-1-delegation/mocked-integration can't.

Tests in the pool:

| File | What it covers (unique value) |
|------|------------------------------|
| `auth.test.ts` | Each of the seven SSO flows **independently** (one browser, one flow at a time) via `DUO_LOGIN_FLOWS` — catches per-flow SSO/Duo DOM drift. |
| `session-launch-multi.test.ts` | `Session.launch` authenticating **≥2 systems** via the production **parallel-staggered Duo** path (parallel `prepareLogin` → `settleMs` → `staggerMs`-spaced Submit → `maxConcurrentDuos` semaphore) — the path the dashboard/daemon actually run; `auth.test.ts` logs in serially and `integration/core/mock-workflow.test.ts` stubs the logins, so neither hits the real concurrent multi-system auth. **System pair: `kuali` + `old-kronos`** pulled from `separationsWorkflow.config.systems` (drops `ucpath`/`new-kronos` to keep two Duos, not four, well under the 180s timeout). **Knobs = production defaults stated explicitly** (`settleMs:2000`, `staggerMs:5000`, `maxConcurrentDuos:1` — one phone prompt at a time). A custom `launchFn` wrapping `launchBrowser({ headless, ... })` makes it headless by default (`Session.launch`'s built-in `defaultLaunchOne` always launches headed). Awaits `session.page(id)` for both systems (resolves only after each readyPromise clears) and asserts each landed off the SSO/Duo URL. Teardown is graceful `session.close()` only — never force-kill (signCount desync). **Fail-fast-and-CLEAN safety:** the test arms its own `AbortController` (`INTERNAL_ABORT_MS = 90_000`, under the 180s pool timeout) and threads it through `Session.launch`'s `abortSignal`. If a hands-off ceremony stalls, the abort fires first and unwinds through `pollDuoApproval`, which finalizes WebAuthn (**persists signCount + tears the authenticator down**) on the abort/throw path too — so a forced abort still exits the ceremony cleanly and the test fails fast with a precise message instead of being `kill -9`'d mid-flight (which would desync signCount). That abort-path teardown is a real product fix in `pollDuoApproval`/`requestDuoApproval` (the daemon stop path aborts auth the same way); pinned CI-side by `tests/unit/infra/auth/duo-poll-abort-teardown.test.ts`. **Multi-system hands-off feasibility:** unverified live as of this writing — each system runs in its OWN browser process so the "one `internal` Touch ID authenticator per Chrome environment" limit is per-process (should not collide across two separate browsers), but two concurrent CDP WebAuthn sessions + a shared `.auth/duo-webauthn.json` signCount file are the residual risk. The safety scaffolding makes a failed run safe regardless; if a live run proves the path can't support 2 concurrent hands-off ceremonies, serialize them (arm→assert→finish one browser fully before the next) or `describe.skip` with a citation and keep the scaffolding for manual phone-Duo runs. |
| `separations-collect.test.ts` | **READ-ONLY Kuali data-collection across the WHOLE Action List.** Authenticates the single `kuali` system from `separationsWorkflow.config.systems` (one-system fast path → **one Duo**, no stagger), opens the Kuali Build Action List, **enumerates EVERY pending document** via the new `listActionListSeparations`/`actionList.docLinks` helper ("the ones that need to be separated"), opens each, and calls `extractSeparationData` per doc — asserting each collected record against the separations schema's field rules (`employeeName` non-empty, `eid` `^\d{5,}$`, `lastDayWorked`/`separationDate` `^\d{2}/\d{2}/\d{4}$`, `terminationType` non-empty). Proves extraction collects correct, complete data for ALL currently-pending separations — not just one known doc. **Never fills/saves/submits** (no `fillTimekeeperTasks`/`fillFinalTransactions`/`clickSave`/`.fill()` call exists in the file); Kuali forms are read, never touched. **Empty Action List = clean no-op** (logs + returns, not a failure). Non-separation Action List docs (the list can hold other types) are enumerated, extraction is attempted, and rows that aren't separation forms are skipped; the test asserts ≥1 enumerated doc yielded a valid separation record. **PII discipline:** logs counts + field-presence + first-name-only crumbs — never full names or EIDs. Same skip guard / headless `launchFn` / graceful-`session.close()` teardown as `session-launch-multi.test.ts`. **Two-phase timing (so a large queue never hard-kills the worker):** PHASE 1 — the auth-safety abort (`INTERNAL_ABORT_MS = 120_000`) is armed before `Session.launch` to unwind a stalled Duo cleanly (preserves signCount), then **cleared the moment `session.page(kuali)` resolves** so it can't fire mid-collection (the per-doc page calls don't observe the abort signal). PHASE 2 — the per-doc loop is bounded by a soft collection budget (`COLLECTION_BUDGET_MS = 120_000`, measured from just before the loop); it **breaks cleanly** at the top of each iteration when the budget (or the abort signal, defensively) trips, leaving the rest as `notReached`. Pass/fail: every REACHED separation form still validates loudly (invalid data fails); coverage accounting is `reached + notReached === enumerated` and `collected > 0` whenever any doc was reached — it does NOT assert the whole list was visited, so a big queue **passes WITH COVERAGE** (summary: `COLLECTED X valid / reached R / enumerated N (notReached=Z due to budget)`) rather than timing out. Per-`it` timeout `300_000` (overrides the pool's 180s) sits comfortably above auth + budget + teardown. Kuali-only, so no multi-system WebAuthn concurrency risk — distinct from the multi-system test above. |
| `separations-dryrun.test.ts` | **The first live WORKFLOW-e2e test — proves the separations DRY-RUN terminal end-to-end against a real pending doc.** Launches ALL THREE separations systems (`kuali`, `new-kronos`, `ucpath` from `separationsWorkflow.config.systems` → parallel-staggered Duo) and drives the REAL workflow through the kernel single-item runner `runOneItem({ item:{ docId, dryRun:true }, trackerDir:<mkdtemp>, callerPreEmits:false })` — deliberately **control-plane-free** (NO daemon claim loop / worker-command / control-ops; bypasses that whole subsystem) so it proves the live READ path + the dry-run write-gate without spawning a daemon. The live companion to the deterministic `tests/unit/workflows/separations/dry-run.test.ts` (which pins the guard with a hand-rolled ctx + mocked steps): this asserts the same terminal is reached when the steps are REAL (live Kuali extract → UCPath Job Summary → New Kronos timecard → date reconciliation). **Reads back the temp tracker's `rows/separations-*.jsonl`** and asserts `result.ok`, a terminal `done` row with `data.status === "Dry Run Complete"`, `data.dryRun` (rides the row STRINGIFIED as `"true"` via the `stringifiedSeed` path — assert `String(...) === "true"`, NOT the boolean the unit test reads off raw `ctx.data`), and that BOTH irreversible writes emitted a `skipped` row (`ucpath-transaction` = the UCPath Smart HR submit, `kuali-finalization` = the Kuali save) — the safety proof that no employee is terminated and no document finalized. **Doc id** via `HR_DRYRUN_DOC_ID` (default a doc pending when written; enumerate current ones read-only via `separations-collect`). The handler's `identity-check` delegates to person-lookup ONLY on a Kuali-vs-Job-Summary name MISMATCH (skipped for a correctly-filed separation, the common case); a mismatched doc would surface the delegation — pick another `HR_DRYRUN_DOC_ID`. Same skip guard / headless `launchFn` / auth-safety abort (Phase 1, `INTERNAL_ABORT_MS = 240_000` for the 3-Duo ceremony, cleared once all three `session.page(id)` resolve) / graceful-`session.close()` teardown as the collect test. Per-`it` timeout `600_000`. Verified GREEN live 2026-06-25 (doc #4361 → `Dry Run Complete`, both writes skipped). |

Rules (these mirror the hard realities of live testing):
- **Opt-in, never CI.** Require `.env` creds + `.auth/duo-webauthn.json` (the enrolled WebAuthn key) + a machine that can run Chromium. Each test **skips cleanly** (precondition guard) when those are absent — never fail/hang on a fresh clone.
- **Serial, clean teardown.** Duo signCount is global server state; the pool is single-fork. Never force-kill mid-ceremony (desyncs signCount → next run rejected as a clone; resync via the one-liner in `docs/engineering/hands-off-duo-webauthn.md` §6).
- **No dashboard pollution.** Workflow e2e (later) drives `runOneItem` with the tracker pointed at a `mkdtemp` dir — rows never touch `.tracker/`, so nothing shows in the dashboard. Auth smoke emits no rows at all.
- **Non-mutating.** Auth smoke lands read-only. Workflow e2e runs in **dry-run** (no Save/Submit) — see `docs/engineering/hands-off-duo-webauthn.md` and the workflow `dryRun` flags.
- **Hands-off setup** lives in `tests/live/_setup.ts` (loads real `.env`, sets `HR_AUTOMATION_DUO_WEBAUTHN=1`). NO log-audit setup — live auth logs to stderr legitimately. Headless by default; `HR_TEST_HEADED=1` to watch.
- **Flow list is shared.** The seven SSO flows come from `src/infra/auth/duo-login-flows.ts` (one source of truth with the `test-login` CLI) — add a flow there and it's covered everywhere.

## Regression clusters

- Dashboard queue/rail counts: backend `wfCounts` regressions belong in `tests/unit/tracker/state-queries.test.ts` and pure count helpers under `tests/unit/tracker/` or `tests/unit/dashboard/`. Pin that counts are backend-authoritative, independent of the selected workflow, and use the same queue-surface model as the rendered rail badges. OCR prep rows that still render in the queue must remain counted until the queue no longer renders them.
- Person lookup dates: tests under `tests/unit/workflows/person-lookup/` should keep UCPath Last Hire/startDate separate from assignment EFFDT/effectiveDate. Dashboard detail fields should show `startDate`; retain `effdt` only as backend context.
- Workflow categories/start surfaces: when a workflow moves category or start-surface eligibility, pin both the workflow config and the loader/surface arrays. Example: delegated utilities such as `i9-lookup` are `category: "Search"` but are not dashboard input/upload starts.

## Lessons Learned

- **2026-05-27: Architecture guards should avoid shell-only tool assumptions.** The origin-workflow lineage guard now scans with Node filesystem APIs instead of spawning `rg`, because Codex sessions can expose ripgrep through a shell path that is not executable from Vitest's `spawnSync`.

## What belongs here

Pure-logic modules: schemas, date math, mapping tables, reducers, regex classifiers, queue/claim logic, JSONL I/O, grid layout math, small string helpers.

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

The vitest config lives at `vitest.config.ts` (project root). It defines two projects (2026-07-17): **`unit`** (`tests/unit/**`, files run in PARALLEL forks — each file is an isolated fork, so `process.env` mutations and module caches stay per-file) and **`serial`** (`tests/delegation/**` + `tests/integration/**`, one file at a time — they drive real daemon processes whose timing flakes under CPU contention). `npm test` runs the two projects back-to-back so the serial lane never shares the machine with the parallel sweep (~70s unit + ~60s serial vs the old ~6.5min single-file run). Gotcha: `extends: true` project configs CONCATENATE array options, so file `include`s live ONLY on the projects — a root-level `include` would union into every project and silently erase the split. A new unit test that writes to a SHARED real path (not a per-test temp dir) can now collide with parallel neighbors — use `mkdtemp` roots; if a test genuinely cannot, it belongs in the serial project.
