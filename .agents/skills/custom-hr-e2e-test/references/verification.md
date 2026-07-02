# Phase 7 — Verifier subagents, lenses, and the issue ledger

## Why this shape

One driver owns the browser (concurrent agents on one headed Chrome race
focus and clicks). Verifiers parallelize safely because they consume only
artifacts (screenshots, API dumps, manifest) and read-only GET endpoints +
tracker files. Cross-workflow consistency is a single-view problem, so one
auditor does it alone at the end — splitting it is how inconsistencies slip
through.

## The four lenses (what "verified" means)

1. **Data travel** — input values arrive where they should, unmangled:
   typed/extracted name + EID → pending row → running row → terminal row →
   fan-out child input → child rows → member rows under coordinators. Any
   field that goes missing after a status transition (latest-wins dedupe
   eats sparse re-emits) is a finding.

   **Short-EID → person-lookup delegation (regression guard):** A separation
   whose Kuali-extracted EID fails `isUcpathEmployeeId` (pattern `^10\d{6}$`,
   e.g. a 7-digit EID like `1061029`) must spawn a delegated person-lookup
   child visible UNDER the separation row in the queue (`parentRunId` set to
   the separation's `runId`). After the child resolves, the corrected
   full 8-digit EID must appear on the separation row's `data.eid` in
   `/api/entries` and must flow into the UCPath Smart HR lookup (visible in
   `kuali-extraction` step log as "EID corrected via person-lookup"). A short
   EID that silently reaches UCPath without delegation (indicated by a
   "No transaction number" failure or by a UCPath step running before a
   person-lookup child appears) is a **high**-severity finding. If
   person-lookup returns no valid EID, the separation must fail loud with an
   explicit "fix the Kuali form" error — a silent continuation is also
   **high** severity.

2. **Row details** — title by kind (person → name, file → PDF filename),
   subtitle EID-else-trace-id, trace-id code + shared root prefix on
   delegated children, status chips (Cancelled orange vs Failed red,
   workflow statusExtensions like A/IA), footer via RowFooter (never
   bespoke), detailFields populated (a declared field that never appears is
   a finding — the kernel even warns).

   **Worker utilization display (regression guard):** In the TerminalDrawer
   session header, daemons actively doing Duo authentication must appear in
   the **authenticating** bucket — NOT in the idle count. If the
   running/authenticating/idle breakdown reads falsely (e.g. "3 running /
   4 idle" while 4 daemons are visibly in `authenticating` phase on their
   session cards), that is a **medium**-severity finding. Verify during any
   phase where a large batch triggers parallel Duo auth across multiple
   workers (Phase B separations dry-run is the primary exercise — 4 systems
   authenticate in parallel).

3. **Log quality** — logs attributed to the right runId/workflow, structured
   fields (`step`, `system`, `category`, `durationMs`) present, sensible
   ordering, no invalid-line spam, no orphan/unattributed session events.

   **Auth / idle-refresh / Duo regression guards:** A clean run must produce
   NONE of the following as hard failures:
   - `"Duo WebAuthn factor not found at the prompt"` followed immediately by
     manual fallback + `"Duo approval timed out"` — signals the CDP
     authenticator was invalidated mid-auth (idle-refresh or stale CDP
     session).
   - Any page reload or navigation event while a daemon is in the
     `authenticating` phase (idle-refresh timer firing mid-auth; check
     daemon session logs for unexpected `page.goto`/`page.reload` during
     auth steps).
   - `"[Auth: <sys>] Retrying (attempt 2/3)"` on a first-time auth with no
     prior failure — indicates the auth guard or WebAuthn re-arm failed
     silently on attempt 1.
   - Any single worker stuck in `authenticating` state (session card phase
     label) with 0 items processed for >5 minutes while other workers are
     running — signals the Duo serial queue is blocked behind that stalled
     request (300s wall-clock max-wait + 200s stale-advance must prevent
     this; if it persists, **high** severity).
   If any of these appear, file as **high** severity with the log excerpt as
   evidence.

   **Modal-mask / overlay regression guards:** A clean run must produce NONE
   of the following as hard failures:
   - `"selector fallback triggered: ucpath reason continue button"` (5s click
     timeout on the UCPath reason "Continue" click — `#pt_modalMask` not
     dismissed first).
   - `#pt_modalMask` or `ps_modalmask` described as intercepting pointer
     events in any log or timeout message.
   - `"timeout-intercepted: Another element intercepted the click (modal/overlay)"`
     in New-Kronos logs (WFD loading-overlay not settled before employee
     search).
   - Repeated Old-Kronos `"modal close button"` (3s) or `"date range calendar
     button"` (10s) timeouts in the same run — indicates the calendar-button
     selector or `dismissModal` timeout regression.
   Any of these is a **medium**-severity finding.

4. **Preview rows** — OCR review pane vs the fixture PDF: extracted
   names/EIDs/fields correct, default selection rules honored (unsigned rows
   deselected), approve/discard reflect into the operation row's denormalized
   status, the OCR row stays the ONE real row in the OCR panel (never
   duplicated by the operation row).

   **Audit screenshot checks (regression guard):** After a separation run
   completes its read steps, verify that audit screenshots were captured
   per-system and match these contracts:
   - **Kuali** — the audit event produces **~3 vertical-slice images** (label
     pattern `kuali-finalization-saved-1of3`, `…-2of3`, `…-3of3`) that
     together cover the entire Kuali form from top to bottom. A single
     full-page screenshot or a single-slice image is a regression.
   - **UCPath** — the audit event produces **~2 vertical-slice images** (label
     pattern `ucpath-…-1of2`, `…-2of2`) covering the entire UCPath form.
   - **Old Kronos + New Kronos** — each produces a **viewport-sized**
     screenshot (NOT fullPage) centered on the last-worked-date row. A tall
     narrow ribbon, a blank grid, or a full-page tall image means the
     viewport-centering (`captureViewportCenteredOnElement`) regressed to
     fullPage. These systems use virtual-scroll grids — fullPage captures
     would produce empty or mis-cropped images.
   - **System isolation** — each screenshot event is labeled by its system
     only; a `kuali`-labeled event must not contain UCPath or Kronos pages,
     and vice versa.
   File a **medium**-severity finding for any contract breach above.

## Dispatch

Spawn in parallel (Explore-type agents are fine; they only read), each prompt
containing: its **fixed agent name**, the artifact dir, the ledger path +
protocol below, the lens(es) it owns, and the phase manifest to walk.

| Agent | Scope |
|---|---|
| `verifier-queue` | Queue panels of every workflow: row details lens over all 18+ runs, cancel badges, batch/operation grouping, member rows |
| `verifier-preview` | Preview-rows lens: every OCR review screenshot + `/api/entries` for prep rows + approve/discard aftermath |
| `verifier-sessions` | Session cards: instance labels (no trailing ordinals), subtitle = running run's trace id, step chips vs `step_change` events, worker counts vs lockfiles, idle states |
| `verifier-logs` | Log-quality lens: tracker `logs/`, log panel dumps, backend stdout, session JSONL orphans |
| `auditor-dataflow` | Data-travel lens END-TO-END + counts triangle (wfCounts ≡ rows ≡ tasks) + trace-id lineage across every delegation — runs AFTER the four verifiers finish, reads their ledger entries first |

The driver does not verify in parallel with them; it waits, then triages.

## Issue ledger (`generated/.e2e/runs/<ts>/issues.jsonl`)

Append-only JSONL. One line per finding, corroboration, or pass:

```json
{"id":"ISS-007","kind":"finding","foundBy":"verifier-queue","phase":4,"area":"queue/oath-upload","dedupKey":"oath-upload:ticket-row-missing-trace-prefix","severity":"medium","title":"Ticket row trace id lost the ou- root prefix after wait-signatures re-emit","evidence":[".screenshots/e2e/<ts>/p4-31-oath-upload.png","generated/.e2e/runs/<ts>/api/p4-31-runs.json"],"status":"open"}
{"id":"ISS-012","kind":"corroboration","foundBy":"verifier-logs","of":"ISS-007","note":"same runId shows prefix-less traceId in logs/oath-upload-*.jsonl line 84"}
{"id":"ISS-009","kind":"pass","foundBy":"verifier-sessions","confirms":"session-card title strips trailing ordinal for every instance","evidence":[".screenshots/e2e/<ts>/p5-12-session-cards.png"]}
```

The orchestrator ADDS two fields to a finding when it triages it to `confirmed`
(agents never set them — they file symptoms, the orchestrator owns causation):

```json
{"id":"ISS-007",...,"status":"confirmed","rootCause":{"where":"src/core/daemon/in-flight-shutdown.ts:emitShutdownRow","confidence":"medium","note":"re-emit synthesizes a parent/archetype not matching the real task"},"regressionTest":null}
```

`regressionTest` stays `null` until Phase 8 lands the deterministic red→green
pin, then becomes its path (e.g. `tests/unit/core/daemon.test.ts::"…VQ-003"`).
A `confirmed` finding with `regressionTest:null` at completion is either
unfinished or an explicit deferral — both must be named in the handoff. This is
the machine-checkable half of the promotion gate.

Protocol — every agent follows it, in this order:

1. **Read the whole ledger before filing anything.** Build the set of existing
   `dedupKey`s.
2. Same underlying defect (same `dedupKey`, or same symptom+location under a
   different name) → file a `corroboration` with `of:<id>`, never a duplicate
   finding. When unsure whether two symptoms share a root cause, file the
   finding and note the suspected `relatedTo` — the orchestrator merges;
   agents never delete or edit other agents' lines.
3. `dedupKey` = `<area>:<symptom-slug>` — name the SYMPTOM, not the suspected
   cause (causes get revised; symptoms dedupe reliably).
4. Severity: `high` = wrong data shown / lost run / wrong terminal state;
   `medium` = wrong presentation, recoverable; `low` = polish.
5. Evidence is mandatory — at least one artifact path per finding. A finding
   the orchestrator can't reproduce from evidence gets bounced back.
6. **No agent fixes anything, and no agent assigns root cause.** Findings only —
   `rootCause`/`regressionTest` are the orchestrator's at triage. The
   orchestrator triages (`open → confirmed | duplicate | rejected`) after all
   agents return, and only confirmed issues flow into Phase 8.
7. **A `pass` record names the invariant it confirms (`confirms:"<sentence>"`),
   never `of:"?"`.** A positive assertion that points at nothing is noise — it
   can't be audited and it can't catch a regression. One `pass` line per
   checkpoint the lens actually verified, each with evidence, so the report's
   "what passed" column is a real list, not a vibe. (`VL-PASS`/`VP-PASS`-style
   bare passes with `of:"?"` are the anti-pattern this replaces.)
8. **Symptom in the ledger, cause in triage.** Keep filing `dedupKey` by symptom
   (causes get revised, symptoms dedupe). The orchestrator's `rootCause` field is
   where a cause is committed to — with a `confidence` level, because a
   wrong-but-confident cause is how a band-aid ships. When two findings turn out
   to share one `rootCause.where`, that is the signal to fix once at the root,
   not N times at the symptoms (the daemon-teardown nest is the standing
   example).
