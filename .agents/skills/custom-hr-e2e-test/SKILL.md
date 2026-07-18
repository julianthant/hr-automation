---
name: custom-hr-e2e-test
description: AI-driven end-to-end test of the HR-automation dashboard — boots the real dashboard against an isolated tracker dir, drives it headed via playwright-cli, queues the full workflow matrix (oath-signature, oath-upload, OCR oath/ec/verify, emergency-contact, onbase), exercises mobile-photo Capture mode and the cancel/parallel-worker matrices against stub daemons (HRAUTO_E2E_STUBS), runs optional live-lane onboarding + separations dry-runs (real CRM/UCPath/I-9/Kuali/Kronos + Duo, the irreversible Smart-HR submits skipped in code), fans out verifier subagents with an issue ledger, then runs review → HTML report → handoff. Use whenever the user asks to run the e2e test, the AI end-to-end test, dashboard e2e verification, the cancel/parallel-worker test matrix, the capture/onboarding-dry-run/separations-dry-run coverage, or a full-dashboard regression pass.
---

# e2e-test — AI-driven dashboard end-to-end test

> **This skill is the hr-automation specialization of the general
> [`custom-e2e-verify`](~/.Codex/skills/custom-e2e-verify/SKILL.md) base.** `custom-e2e-verify`
> owns the METHODOLOGY: driver/verifier topology, double-entry ground truth,
> "a workaround is a finding", the issue-ledger schema, the red→green promotion
> gate, the report+approval+handoff shape, and the `/custom-review-code` invocation.
> This skill supplies the HR SPECIFICS: the workflow matrix (including OnBase),
> the stub lane + isolation setup, fixtures, Duo live lanes, and safety rails.
> Read `custom-e2e-verify` for the methodology; read this skill for the what and how
> of this particular dashboard test. When the base and this skill overlap, the
> base's phrasing is authoritative — this skill's detail is additive, not a
> re-derivation.

You are the **driver/orchestrator** of a multi-phase test of the real dashboard.
The test subject is the dashboard + kernel + daemon machinery — queue rows,
cancellation, parallel workers, delegation, data flow — NOT the external HR
systems. Mode C: the full matrix runs against **scripted stub daemons**
(`HRAUTO_E2E_STUBS=1`, zero external/Duo risk); an optional **live lane** at the
end validates the real path on read-only workflows, only with the user present.

## Hard safety rails

- **Isolated tracker root, always.** Every stub-lane process runs with
  `HRAUTO_TRACKER_DIR=$(pwd)/generated/.e2e/tracker` (gitignored). Never set
  `HRAUTO_E2E_STUBS=1` against the real `.tracker/` — stub terminal rows would
  pollute real history and dup-probes.
- **Verify stub mode before enqueueing anything**: the backend/daemon logs must
  show `[e2e-stubs] workflow "<name>" running with SCRIPTED handler`. No
  banner → stop, fix env, restart.
- **Never enqueue non-stubbed workflows in stub mode** (separations,
  onboarding, work-study, crm-doc-download — they'd run REAL handlers; the
  loader logs an error for them). Onboarding and separations have no stub
  handler by design — they are exercised ONLY in the live lane, each via its
  in-code `dryRun` guard (Phase A onboarding, Phase B separations). Never run
  them under `HRAUTO_E2E_STUBS`.
- **Stub-lane OCR runs must never use roster "download"** — OCR runs in-process
  in the dashboard (real Gemini, by design) and roster download delegates to the
  REAL sharepoint-download. Use an existing/fixture roster or a roster-less path.
- **One agent on the browser.** Only the driver touches the playwright-cli
  session. Verifiers read artifacts + GET APIs only. Close playwright-cli
  sessions when done; sweep orphans.
- Set the **dryRun toggle** on every run modal that offers it (defense in depth
  on top of stubs).
- Local commits only; never push.

## Driver discipline — a workaround is a finding

The driver acts ONLY as a real operator could through the dashboard UI. Any
action a real operator has no button for — a manual `POST /wake` to unstick an
idle daemon, a direct `sqlite3 … UPDATE`, re-clicking a control that silently
no-op'd, hand-editing a tracker row, killing/restarting a daemon to clear a
wedge — is itself a **finding**, never a workaround. File it (`severity ≥
medium`, `dedupKey` naming the symptom) BEFORE continuing, then take the minimum
manual step to proceed and stamp `workaroundUsed:"<what>"` on that manifest line
so the phase's "pass" is visibly conditional.

The danger is **silent masking**. ISS-001 (idle daemons never auto-woken) almost
passed because the driver's own `/wake` made the OCR pipeline proceed — the bug
was real, the poke hid it. "It worked after I poked it" is the symptom, not the
all-clear. If a phase only advances via an operator-impossible action, the phase
result is `ok:false` with that action recorded, full stop.

Setup/harness quirks (roster-on-disk-before-page-load, JSON-string
`data.records`, port-conflict restart) are fine to work around silently — UNLESS
the quirk is one a real operator would also hit (an absent roster defaulting to
the forbidden SharePoint download), in which case it is ALSO a product finding,
not just a driver note.

## Environment

```bash
mkdir -p generated/.e2e/tracker generated/.e2e/runs
export HRAUTO_TRACKER_DIR="$(pwd)/generated/.e2e/tracker"
export HRAUTO_E2E_STUBS=1
npm run dashboard          # backend :3838 + Vite :5173; daemons inherit env via spawnDaemon
```

The backend does NOT hot-reload — any env or backend change needs a full
restart. Port 3838 conflict → find and kill the stale server first.

All e2e artifacts live under one home, `generated/.e2e/` (gitignored):
`tracker/` is the dashboard's isolated tracker data (set above) and `runs/` is
this harness's per-run bookkeeping. Per run, create a run workspace and use it
for everything:

- `generated/.e2e/runs/<YYYYMMDD-HHMM>/` — `manifest.jsonl` (checkpoints),
  `issues.jsonl` (ledger), `api/` (state dumps), `report.html`, `handoff.md`
- `.screenshots/e2e/<YYYYMMDD-HHMM>/` — every UI screenshot, named
  `p<phase>-<seq>-<what>.png`

Drive the dashboard at `http://localhost:5173` with the **playwright-cli**
skill, headed. Stub daemons launch no browsers (`systems: []`) — that is
correct, not a failure; only the dashboard Chrome and (live lane) real daemon
browsers are visible.

**Hold gates** make runs park deterministically (cancel-running tests):
`generated/.e2e/tracker/e2e-gates/<workflow>.hold` parks every step;
`<workflow>--<step>.hold` parks one step. Create before enqueueing, remove to
release. oath-upload additionally parks naturally at `wait-approval` /
`wait-signatures`.

**Fixtures**: `data/documents/multiple-oath.pdf` (3 signers), `single-oath.pdf`,
`emergency-contacts.pdf` (all gitignored — "may contain PII"). If the OCR oath/EC
flow demands a roster, build the matching fixture roster with
`node data/documents/make-e2e-roster.mjs` — it reads the gitignored local sidecar
`data/documents/e2e-roster-identities.json` (real names+EIDs, also kept out of git)
and writes `data/documents/e2e-fixture-roster.xlsx`. **Never download** in the stub
lane. If the sidecar is absent, bootstrap it once: run one OCR prep, read the
extracted names from the preview, write them into the sidecar, then run the
generator. The generator is committed (PII-free); the sidecar + .xlsx are local.

## Ground truth (double-entry rule)

Every UI assertion is paired with a ground-truth assertion — the UI is itself
under test. Sources:

- `GET /api/runs`, `/api/entries?workflow=<wf>&date=<YYYY-MM-DD>`,
  `/api/tasks?workflow=<wf>`, `/api/sessions?workflow=<wf>`
- SSE `/events/hub` (`entries`, `wfCounts`, `failureCounts`, `sessionsUpdate`)
- JSONL: `rows/`, `logs/`, `sessions/` under the e2e tracker dir; SQLite
  `state.db`; `debug/row-lifecycle-*.jsonl`
- Daemon lockfiles `daemons/*.lock.json` + each daemon's `/whoami`

## Phases

Run in order; read `references/phases.md` for the full per-phase procedure and
assertions before starting each phase.

| # | Phase | One-liner |
|---|-------|-----------|
| 0 | Setup | Env, dashboard up, stub banner verified, baseline screenshots |
| 1 | Enqueue matrix | 7 variants × 3 runs through the real UI, holds pre-set |
| 1b | Capture mode | 📷 mobile-photo→PDF→OCR-prepare for oath-signature + EC; phone simulated over the capture HTTP API; OCR prep row appears as if a PDF were uploaded, then joins the Phase 1/4 OCR assertions |
| 2 | Cancel queued | One queued run per variant via row cancel |
| 3 | Cancel running | Parked runs cancelled; OCR discard; reassign; tree cancel |
| 4 | Run survivors | Release holds, approve OCR in UI, verify completions + fan-out; **fail-injection matrix → red Failed → Retry → `original_input_json` replay → done** (≥1 leg per family + ≥1 non-throw failure kind, not one global leg) |
| 5 | Parallel workers | N spawn/reuse/no-overspawn, add-worker-mid-run no-steal (lease renewal), stop-instance reassign, Stop All |
| 6 | Resilience | Reload rehydration, counts consistency, lifecycle log clean |
| 7 | Verification fan-out | Verifier subagents + data-flow auditor (`references/verification.md`) |
| 8 | Review + fixes | Root-cause fixes; **each confirmed finding promoted to a deterministic red→green pin (authored via `/test-writer:test-writer`) before it counts as "fixed"**; `/custom-review-code` invocation; ui-ux-pro-max (for frontend-visible fixes only) |
| 9 | Report + handoff | Canonical HTML before/after report (via `render-report.mjs`) → user approval → handoff doc |

The matrix (person-lookup and sharepoint-download are **delegation-verified
only** — never enqueued directly):

| Variant | Start surface | Notes |
|---|---|---|
| oath-signature (PDF) | Oath Signature panel RunModal → `/api/ocr/prepare` | operation row + delegated OCR |
| oath-upload (full) | Oath Upload panel RunModal → `/api/ocr/prepare` | born-at-upload ticket row, real wait logic |
| OCR oath | OCR panel RunModal, formType oath | standalone — approve must reject loud |
| OCR emergency-contact | OCR panel RunModal, formType emergency-contact | standalone |
| OCR verify | OCR panel RunModal, verify | fans out person-lookup + i9-lookup (stubs) |
| emergency-contact (PDF) | EC panel RunModal → `/api/ocr/prepare` | operation row + delegated OCR |
| onbase (PDF) | OnBase panel RunModal → `/api/ocr/prepare` | operation row + delegated OCR (onbase-emergency-contact form), fans `operation-member` rows to the onbase daemon |

## Subagent topology + coordination

One **driver** (you) on the browser; parallel **verifiers** per area
(`verifier-queue`, `verifier-preview`, `verifier-sessions`, `verifier-logs`)
working from artifacts + GET APIs; one **auditor-dataflow** at the end for
cross-workflow consistency. Verifier briefs, the four verification lenses
(data travel, row details, log quality, preview correctness), the issue-ledger
schema, and the dedup protocol are in `references/verification.md` — every
dispatched agent gets its fixed name, the ledger path, and the
read-ledger-before-filing rule in its prompt. No agent fixes anything during
phases 0–7; the orchestrator owns triage.

## Completion

Phases 8–9 (the `/custom-review-code` invocation, ui-ux-pro-max verification for
frontend fixes, the canonical HTML report, the approval gate, and the handoff
format) are specified in `references/report-handoff.md`. The run is complete
when: every phase's checkpoints are in the manifest, the ledger is fully triaged
(no `open` issues), **every `confirmed` finding is either promoted to a
deterministic red→green regression pin — authored with the `/test-writer:test-writer`
skill, in the lowest layer that can hold it (usually a `tests/delegation/`
daemon-soak or `tests/unit/core/daemon*.test.ts` case) — or explicitly deferred
with a documented root cause in the handoff** (a finding fixed with no pin is
not done — it will be rediscovered by the next expensive run), the user has
approved the report, and the handoff doc is written. Docs update after code
settles is the human's call to mention — do NOT invoke a doc-reviewer agent as
part of this skill.
Tear down: remove hold gates, stop all daemons (`/api/daemon/stop` per
workflow), stop the dashboard, close playwright-cli sessions, leave
`generated/.e2e/tracker` in place (evidence) but note its size.

## Optional live lane (ask first)

Only with the user present (Duo): restart backend WITHOUT `HRAUTO_E2E_STUBS`
(keep the isolated tracker dir), then: one person-lookup typed input run
(read-only), one OCR run with roster **download** (exercises real
sharepoint-download delegation, read-only), and — only when the user opts in —
one **onboarding dry-run** (Phase A) and/or one **separations dry-run**
(Phase B). Phases A and B are independent — run either, both, or neither per
what the user opts into; each restarts nothing extra (same live-lane backend).

**Allowed vs prohibited live mutations.** The live lane is read-only EXCEPT for
the onboarding and separations dry-runs. Each writes nothing irreversible
because its committing step(s) are skipped **in code** when `dryRun` is set:
- **Onboarding** — the single UCPath Smart HR submit is skipped at the
  `transaction` step → no UCPath transaction is created.
- **Separations** — BOTH irreversible writes are skipped: the UCPath Smart HR
  submit (`ucpath-transaction`) AND the Kuali finalization save
  (`kuali-finalization`) → no UCPath transaction is created and the Kuali
  document is never finalized.

Those code-enforced skips are what make these two safe to run live; nothing
else here mutates. Never run oath-signature / EC / oath-upload live from this
skill — even with `dryRun`, those write real artifacts/tickets and are a manual
decision outside the e2e test. Onboarding and separations are the ONLY mutating
workflows this skill runs live, and only in dry-run.

### Phase A — Onboarding (LIVE-lane dry-run)

Onboarding CANNOT run in stub mode (no stub handler — it stays in the "never
enqueue non-stubbed workflows in stub mode" list). It runs in the LIVE lane
with the new `dryRun` flag: real CRM / UCPath / I-9 + Duo, but the irreversible
UCPath Smart HR submit is skipped. This phase EXTENDS the live lane to a
mutating workflow run in dry-run — see "Allowed vs prohibited live mutations"
above before starting.

**Safety rail (all four MUST hold before you click Run):**

1. Backend is restarted WITHOUT `HRAUTO_E2E_STUBS` (live lane), isolated tracker
   dir kept.
2. The **Dry run** toggle is ON for this run (verify it visually in the run
   panel before clicking Run — a missed toggle means a REAL Smart HR submit).
3. The user is present for the **2 Duo prompts** (CRM, then UCPath).
4. Post-run you will verify NO transaction was submitted (ground-truth below)
   before declaring the phase passed.

**Start from the dashboard UI:** select **Onboarding** in the rail → the
`InputRunPanel` at the bottom → type email **`dong7777125@gmail.com`** → click
the **settings gear (Settings2 icon)** beside Run → flip the **Dry run** switch
ON → click **Run** (Play). A daemon spawns if none is alive.

**Duo:** 2 prompts — CRM (`crm-auth`) then UCPath (`ucpath-auth`). I-9
(`i9-creation`) is SSO, **no Duo**.

**The 8 steps to monitor, in order:** `crm-auth` → `crm-search` → `extraction`
→ `pdf-download` → `ucpath-auth` → `person-search` → `i9-creation` →
`transaction`. Monitor the ENTIRE lifecycle; ANY step error is a finding
(`severity ≥ medium`, `dedupKey` naming the step) — file it and make effort to
fix per the "a workaround is a finding" discipline.

**Dry-run terminal:** at the `transaction` step the run screenshots
`onboarding-dry-run-before-submit`, logs `DRY RUN: reached Smart HR transaction
— submit skipped (no UCPath mutation)`, stamps `data.status = "Dry Run
Complete"` + `data.dryRun = true`, and ENDS succeeded / `done` — this is NOT a
failure.

**Assertions (UI + ground-truth double-entry, per the skill's rule):**

- Each of the 8 steps completes without error (step chips advance, no red
  badge).
- `extraction` populated the employee fields — name / dept # / position # /
  wage / effective date — visible both in the detail panel **and** in
  `/api/entries` for onboarding (data-travel lens).
- `i9-creation` produced or found an `i9ProfileId` (present on the run's
  `data`).
- The run reaches `transaction` and HALTS with `data.status === "Dry Run
  Complete"` + `data.dryRun === true`; the run terminalizes `done`, NOT failed.
- The `onboarding-dry-run-before-submit` screenshot exists in the screenshots
  dir.
- **Ground-truth — NO UCPath Smart HR transaction was created:** the row never
  went past the pre-submit boundary — `clickSaveAndSubmit` was never called and
  there is **no** `onboarding-transaction-submitted` screenshot (that screenshot
  exists only on the real, non-dry-run path). This is the load-bearing
  no-mutation proof.
- Onboarding is a `pool` batch (`poolSize 4`) — a single email still renders as
  a **batch** surface; assert the shape, don't mistake the lone batch surface
  for a bug.

**Caveats the driver MUST know:**

1. **CRM record prerequisite.** `dong7777125@gmail.com` must exist as a CRM
   recruitment/onboarding record, or `crm-search` throws `No search results
   found` and the run fails pre-guard (before reaching any UCPath step). This is
   a data prerequisite, not a product bug — confirm the record exists before
   running.
2. **Rehire short-circuit (expected, not a failure).** If `person-search` finds
   an existing UCPath match, the run records `rehire: Yes` and returns BEFORE
   `i9-creation` / `transaction` — so it never reaches the dry-run guard. That is
   correct behavior, but the run then does NOT exercise the full path through the
   dry-run terminal; note it in the manifest and (if you need the full path)
   pick an email with no existing UCPath match.

### Phase B — Separations (LIVE-lane dry-run)

Separations CANNOT run in stub mode (no stub handler — it stays in the "never
enqueue non-stubbed workflows in stub mode" list). It runs in the LIVE lane
with the `dryRun` flag: real Kuali / Old Kronos / New Kronos / UCPath + Duo,
but the two irreversible writes are skipped. This phase EXTENDS the live lane
to a SECOND mutating workflow — see "Allowed vs prohibited live mutations"
above before starting.

**Why separations is riskier than onboarding (read first).** Onboarding has ONE
irreversible write (the Smart HR hire submit). Separations has TWO — the UCPath
Smart HR **termination** submit AND the Kuali document **finalization** save —
and the input is a batch of REAL employees. A missed `dryRun` toggle here does
not create one stray transaction; it **terminates every doc in the batch**. The
dry-run terminal halts the handler after date reconciliation and before the
first Kuali write, skipping `ucpath-transaction` + `kuali-finalization`. Treat
the toggle as load-bearing.

**Safety rail (all four MUST hold before you click Run):**

1. Backend is restarted WITHOUT `HRAUTO_E2E_STUBS` (live lane), isolated tracker
   dir kept.
2. The **Dry run** toggle is ON for this run (verify it visually in the input
   panel's run-settings gear before clicking Run — a missed toggle means REAL
   terminations of every doc in the batch).
3. The user is present for the **4 Duo prompts** (Kuali, Old Kronos, New Kronos,
   UCPath — parallel-staggered, so they overlap on the phone and may be approved
   in any order). They authenticate ONCE at session start and are reused for the
   whole batch — NOT 4 Duos per doc.
4. Post-run you will verify NO UCPath transaction was submitted AND the Kuali
   doc was NOT finalized, for every doc (ground-truth below), before declaring
   the phase passed.

**Start from the dashboard UI:** select **Separations** in the rail → the
`InputRunPanel` at the bottom → type the doc ids **comma-separated**:
`4131, 4130, 4129, 4128, 4127, 4126, 4125, 4124, 3917` → click the **settings
gear (Settings2 icon)** beside Run → flip the **Dry run** switch ON → click
**Run** (Play). A daemon spawns if none is alive. (These are Kuali **document
ids**, not EIDs — `inputSubject: "kualiId"`, parsed by `parseCommaSeparated("docId")`.)

**Duo:** 4 prompts — Kuali, Old Kronos, New Kronos, UCPath — once per session.

**The 5 steps to monitor, per doc, in order:** `kuali-extraction` →
`kronos-search` → `ucpath-job-summary` → `ucpath-transaction` →
`kuali-finalization`. In dry-run the run HALTS at the dry-run terminal after
`kronos-search`/date reconciliation — `ucpath-job-summary`, `ucpath-transaction`,
and `kuali-finalization` are stamped SKIPPED (not run). ANY error in the read
steps is a finding (`severity ≥ medium`, `dedupKey` naming the step).

**Dry-run terminal:** at the dry-run boundary the run screenshots
`separations-dry-run-before-submit`, logs `DRY RUN: reached UCPath Smart HR
transaction for doc #<id> — Kuali writes, UCPath submit, and Kuali finalization
all skipped`, stamps `data.status = "Dry Run Complete"` + `data.dryRun = true`,
and ENDS succeeded / `done` — this is NOT a failure.

**Row shape (corrected 2026-06-22, ISS-B01):** separations declares
`archetype: "single"`, but a **multi-doc** dashboard input run is a **batch
surface** — NOT N flat single rows. The kernel's "dashboard direct input
batches" path stamps `runtimeOptions.rowShape = "batch-member"`, so N (>1) doc
ids render as a **batch anchor** ("N rows batch queue, M of N done" + a "Retry
all N in this batch" footer) over N **`batch-member`** rows ("Separation
<doc>"), consistent with the general workflows model (multi-person/subject input
runs are batch surfaces with batch-member rows). A **single-doc** run stays a
flat `single` row. Either way the run is a **sequential** batch
(`betweenItems: ["reset"]`) processed one at a time by one daemon that
authenticates the 3 browsers once and runs `session.reset(id)` between docs;
each row carries a `se-<HHMMSS>-<runId4>` trace id. Do NOT expect onboarding's
`pool` shape — the sequential batch reuses one session, it does not spawn a
worker pool.

**Assertions (UI + ground-truth double-entry, per the skill's rule), per doc:**

- The read steps (`kuali-extraction`, `kronos-search`) complete without error
  (step chips advance, no red badge), then the run reaches the dry-run terminal.
- `kuali-extraction` populated the employee fields — name / EID / Last Day
  Worked / Separation Date / Term Type — visible both in the detail panel
  **and** in `/api/entries` for separations (data-travel lens).
- The run HALTS with `data.status === "Dry Run Complete"` + `data.dryRun ===
  true`; the run terminalizes `done`, NOT failed.
- `ucpath-transaction` and `kuali-finalization` are SKIPPED (the kernel marks
  them skipped; no step chip shows them running/done).
- The `separations-dry-run-before-submit` screenshot exists in the screenshots
  dir for the doc.
- **Ground-truth — NO UCPath Smart HR transaction was created:** the row has no
  `data.transactionNumber` and there is **no** `ucpath-transaction-submitted` /
  `ucpath-transaction-submitted-missing-number` screenshot (those exist only on
  the real, non-dry-run path). This is one load-bearing no-mutation proof.
- **Ground-truth — the Kuali document was NOT finalized:** `kuali-finalization`
  never ran (skipped), so no transaction-number/date-change comment was written
  back to the Kuali form and the doc was never saved/advanced. This is the
  second load-bearing no-mutation proof (separations-specific — onboarding has
  no equivalent).
- Sequential-batch shape: exactly one separations daemon/session, 4 browsers
  authenticated once (one `item_start` worker per session, reused across docs —
  same `workerId`), `session.reset` between docs; 9 single rows, never a batch
  anchor.

**Regression checks specific to Phase B** (file as findings if these
contract violations appear — they indicate recently-fixed bugs regressing):

- **Auth / idle-refresh during multi-system auth:** All 4 system browsers
  (Kuali, Old Kronos, New Kronos, UCPath) authenticate in parallel-staggered
  order. Watch the daemon logs for `"[Auth: <sys>] Retrying (attempt 2/3)"`,
  any page reload while a system is in `authenticating`, or
  `"Duo WebAuthn factor not found at the prompt"`. These indicate the
  idle-refresh guard or WebAuthn re-arm regressed — file **high** severity.
  Also verify the TerminalDrawer running/authenticating/idle counts during
  the Duo phase: authenticating workers must appear in the `authenticating`
  bucket, not the idle count (file **medium** if miscounted).

- **Modal-mask in UCPath and Kronos steps:** After `kuali-extraction`, the
  pipeline proceeds to `ucpath-job-summary` (in a full run) and touches
  Kronos. Watch for `"selector fallback triggered: ucpath reason continue
  button"` or `#pt_modalMask` / `ps_modalmask` intercepting clicks in UCPath,
  and `"timeout-intercepted: Another element intercepted the click"` in
  New-Kronos, or repeated Old-Kronos calendar button timeouts. A clean run
  has NONE of these as hard failures.

- **Short-EID delegation:** If any doc in the batch has a Kuali-extracted EID
  that fails `^10\d{6}$` (e.g. 7 digits), a delegated person-lookup child
  must appear UNDER that separation row before `ucpath-job-summary` runs.
  The corrected EID must be visible on the row's `data.eid`. A short EID
  reaching UCPath without a child delegation row is **high** severity; a
  failure with "No transaction number" on a short-EID doc that skipped
  delegation is the telltale symptom.

- **Kuali audit screenshot (3 slices):** At `kuali-extraction` completion,
  confirm ~3 labeled screenshot slices (`kuali-finalization-saved-1of3`,
  `…-2of3`, `…-3of3`) exist in `.screenshots/e2e/`. A single-image or
  missing Kuali audit is **medium** severity.

**Caveats the driver MUST know:**

1. **Pending-doc prerequisite.** Each doc id must be a CURRENTLY-PENDING
   separation in the Kuali Build Action List, or `kuali-extraction` cannot read
   the form and the doc fails pre-guard. This is a data prerequisite, not a
   product bug — confirm the docs are pending (the read-only
   `tests/live/separations-collect.test.ts` enumerates the live Action List if
   you need to verify which ids are actionable). Doc ids that have already been
   processed or don't exist will fail extraction; note them in the manifest and
   don't count them as product findings.
2. **Future-dated separation (expected, not a failure).** A doc whose Last Day
   Worked or Separation Date is in the future fails the
   `validateLastDayWorked` preflight loud — by design (the record isn't yet
   actionable). Note it; it is not a dry-run-path failure.
3. **One residual Kuali write in dry-run (benign).** The timekeeper-name fill
   bundled into `kronos-search` touches the UNSUBMITTED Kuali draft before the
   dry-run terminal. It commits nothing (the doc is never finalized), mirroring
   onboarding's pre-submit I-9 create. Don't flag it as a mutation — but DO
   confirm nothing past it (dept/payroll fill, date corrections, finalization)
   ran.
4. **Batch all-or-nothing on the toggle.** The dry-run toggle folds onto EVERY
   parsed doc id at once — there is no per-doc toggle. Verify it once, visually,
   before Run; it then applies to all 9.
