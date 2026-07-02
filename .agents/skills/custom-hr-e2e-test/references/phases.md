# Phases 0–6 (incl. 1b Capture) — detailed procedure + assertions

Every step below produces: (a) a screenshot when the UI changed, (b) a manifest
checkpoint line, (c) paired UI + ground-truth assertions. Manifest line shape:

```json
{"phase":1,"seq":12,"action":"enqueue oath-signature run 2/3","runId":"…","traceId":"os-…","ok":true,"evidence":["p1-12-….png","generated/.e2e/runs/<ts>/api/p1-12-runs.json"],"note":""}
```

A failed assertion is NOT a stop: file it in the ledger, mark `ok:false`,
continue unless the failure blocks the phase mechanically.

## Phase 0 — Setup

1. Env + dirs per SKILL.md; `npm run dashboard` in background; wait for :3838
   and :5173 to respond.
2. Open headed playwright-cli session → `http://localhost:5173`. Screenshot the
   empty dashboard (baseline — the report's "before").
3. Confirm the stub banner: backend log or daemon log contains `[e2e-stubs]`.
   Tail-grep, save to manifest evidence.
4. Dump `/api/runs` (expect empty), SSE `wfCounts` (expect zeros). Screenshot
   the rail.
5. Pre-create hold gates for the stub daemon workflows that will claim work:
   `oath-signature.hold`, `emergency-contact.hold`, `onbase.hold`,
   `person-lookup.hold`, `i9-lookup.hold` (oath-upload parks naturally at
   wait-approval).

## Phase 1 — Enqueue matrix (7 variants × 3)

Enqueue sequentially (this also staggers the in-process Gemini OCR preps).
For OCR-prep-backed variants, vary the fixture across the 3 runs
(`multiple-oath.pdf`, `single-oath.pdf`, and one repeat) so preview-row
verification sees both shapes. Set dryRun ON and workers Auto everywhere
(parallel workers get their own phase).

After EVERY enqueue assert (UI ↔ ground truth):

- Queue row appears in the right panel with correct **shape** (operation row
  for oath-signature/EC/onbase PDF; single ticket row for oath-upload; preview
  row for standalone OCR), **title by kind** (file → PDF filename), **subtitle**
  = EID or trace id, trace-id format `<code>-<HHMMSS>-<runId4>` with the right
  code (`os`/`ou`/`oc`/`ec`/`ob`).
- Task state (`/api/tasks` is NOT a route — query `sqlite3 <trackerDir>/state.db
  "SELECT workflow,task_kind,control_state FROM tasks"`): daemon-workflow tasks
  `queued` (or `running` for the first claim, parked at a hold); OCR rows: prep
  running → `awaiting-review`. (`/api/task-dependencies` + `/api/runs` are the
  real task-adjacent routes.)
- Rail `wfCounts` increments match a hand count of visible top-level rows.
- Operation rows denormalize OCR status (`awaiting review` label + working
  "Open OCR review" link — click one, verify it switches panel + opens Preview,
  screenshot, go back).
  - Ground-truth the denormalization on the operation row's `data`
    (`/api/entries` for the operation workflow): all four of `data.ocrStatus`
    (`awaiting-review`), `data.ocrStep` (`awaiting-approval`), `data.ocrRunId`,
    `data.ocrSessionId` are present, and `data.ocrRunId` === the delegated OCR
    review row's runId (`data.ocrSessionId` === its session id) — these back the
    "Open OCR review" routing + link, not the displayed label.
- Operation coordinator is the ROOT (`parentRunId` null); the OCR review row is
  delegated UNDER it (`parentRunId` === operationRunId) and is the ONE real row
  in the OCR panel (the operation row never duplicates it). The delegated OCR
  review row composes the operation's exact `<code>-<HHMMSS>` trace PREFIX:
  oath-signature operation → `os-`, EC operation → `ec-`, onbase operation →
  `ob-`, oath-upload ticket → `ou-` (assert the OCR child's raw trace id starts
  with the operation row's `<code>-<HHMMSS>` prefix — not merely the same code).
- oath-upload ticket rows reach `wait-approval` (status `awaiting-approval`),
  born as a `single` / file-kind / ROOT row (NOT an operation row); the OCR prep
  is delegated under the ticket (`parentRunId` === ticketRunId) and composes the
  ticket's `ou-<HHMMSS>` prefix.

**onbase (PDF) enqueue — additional assertions:**
- The OnBase panel RunModal uploads a PDF → `/api/ocr/prepare?formType=onbase-emergency-contact&targetWorkflow=onbase`. Assert: an operation coordinator row appears in the OnBase panel (shape `operation`, ROOT, `parentRunId` null); its trace prefix is `ob-<HHMMSS>`.
- The delegated OCR review row appears in the OCR panel with `formType: "onbase-emergency-contact"` and composes the `ob-<HHMMSS>` prefix (NOT `ec-` or `oc-`).
- The onbase daemon workflow IS registered and its hold gate is armed — the onbase daemon should claim its stub work once OCR is approved and fan-out `operation-member` rows land.

End of phase: 21 runs alive (7 variants × 3). Dump all four GET APIs to `api/`.

## Phase 1b — Capture mode (mobile-photo → PDF → OCR-prepare)

Capture (the 📷 button) is the mobile-photo intake path: an operator opens a
QR, snaps photos on a phone, and the bundle becomes a PDF that feeds the SAME
OCR prepare hub a file upload uses. It is registered for **oath-signature** and
**emergency-contact** only (`captureRegistrations` in
`src/tracker/dashboard/capture-state.ts`). Run it in the **stub lane** — the
downstream oath/EC daemons are stubbed; only capture's finalize calls the REAL
`/api/ocr/prepare` (and the in-process Gemini OCR, by design).

The phone is **simulated by the driver over the capture HTTP API** — no real
phone, no QR scan. Do both target workflows (oath-signature and EC) so both
`captureRegistrations` entries are exercised.

**Stub-lane safety (same rule as every OCR run here):** capture's OCR run must
NOT use roster **download** — that delegates to the REAL sharepoint-download.
`makeCaptureFinalize` picks `rosterMode:"existing"` when an `.xlsx` is present in
the roster dirs and falls back to `"download"` when none is — so before
finalizing, ensure the fixture roster is on disk (`tests/data/make-e2e-roster.mjs`
→ `.xlsx` placed in the e2e tracker's roster dir) or run the roster-less
oath path; never let an absent roster trigger the download fallback.

1. **Operator side (UI, optional screenshot).** With the target workflow
   selected, click the **📷 Capture** button → `CaptureModal` opens showing a QR.
   Screenshot it (`p1b-01-capture-qr.png`) as the operator-visible artifact, but
   the driver does NOT scan it — it drives the phone over HTTP next.
2. **Simulate the phone over HTTP** (driver = the phone):
   - `POST /api/capture/start` with body `{ "workflow": "<oath-signature|emergency-contact>" }`
     → returns `{ ok, sessionId, token, captureUrl, qrSvg, shortcode, expiresAt }`.
     The session is born in state `open` (there is NO `starting` state — the
     create IS the open).
   - `POST /api/capture/upload?token=<token>` with a multipart body whose file
     part is named `file` — a small **fixture image** that pdf-lib can decode:
     a real **JPEG or PNG** (e.g. an existing screenshot PNG, or render one from
     `tests/data/`), **NOT HEIC** (pdf-lib cannot decode HEIC). Returns
     `{ ok, photoIndex, totalPhotos, blurScore?, blurFlagged? }`. Upload at least
     one photo; a second optional upload exercises multi-page bundling.
   - `POST /api/capture/finalize` with body `{ "token": "<token>" }` → bundles
     the photos into a PDF and calls the OCR prepare hub. Returns
     `{ ok, sessionId }`.
3. Drive the SAME flow for the OTHER target workflow (so both
   oath-signature and emergency-contact captures land an OCR prep row).

Assert (UI ↔ ground truth):

- **Session state walk:** the capture session advances `open → finalizing →
  finalized` (query `GET /api/capture/sessions` or `/api/capture/manifest/:token`).
  No `discarded` / `expired` terminal on the happy path; a stalled session that
  expires (idle sweep) or a rejected upload is a finding, not the expected walk.
- **Bundled PDF on disk (ground-truth):** the finalized PDF exists at
  `.tracker/uploads/<sessionId>.pdf` (full UUID sessionId, not sliced) under the
  e2e tracker dir — `makeCaptureFinalize` hands exactly this path to the OCR
  prepare handler.
- **OCR prep row appears as if a PDF were uploaded:** on finalize, an OCR prep
  row appears in the queue for the target workflow's operation surface, file-kind
  **preview** row, status `awaiting review` — identical in shape to the
  Phase 1 PDF-upload OCR prep (operation coordinator + delegated OCR review row,
  the OCR row being the ONE real row in the OCR panel). Assert the prep row's
  trace prefix and the operation/delegation composition exactly as Phase 1 does
  for an uploaded PDF (`os-` for oath-signature, `ec-` for EC).
- **Then hand off to the existing OCR assertions — do NOT duplicate them.** From
  the `awaiting review` prep row onward, a captured document follows the SAME
  approve → fan-out path the Phase 1 (denormalization) and Phase 4
  (approve + `operation-member` fan-out, member identity, no-orphan) assertions
  already cover. Reference those phases for the captured row rather than
  re-asserting the OCR lifecycle here.

File any capture error as a finding (`severity ≥ medium`, `dedupKey` naming the
symptom): session expiry before finalize, an upload rejected (size/type), a
finalize failure, the bundled PDF missing at the expected path, or no OCR prep
row appearing after finalize.

## Phase 2 — Cancel one QUEUED run per variant

Daemon-workflow variants: pick a run still `queued` in the SQLite `tasks` table
(`control_state='queued'`, never claimed), cancel via the row's footer cancel. Assert: SQLite task →
`cancelled`; terminal JSONL row `status:"failed"`, `step:"cancelled"`; UI shows
the orange **Cancelled** badge (not red Failed); `wfCounts` decrements; the
frozen trace id on the cancelled row is UNCHANGED from its pending row.

OCR-family variants have no queued state (prep starts at upload): instead
cancel one prep **mid-OCR** (while step is still extracting — row cancel routes
to `runRegistry.cancel`, the prep must unwind, no orphaned awaiting-review
row), or if all three already reached awaiting-review, **discard** one (the
cancel-variant) and assert the discard cascades correctly: for an oath-upload
operation, the parked ticket's `wait-approval` must reject (`OcrDiscardedError`)
→ ticket fails loud with no ticket number.

## Phase 3 — Cancel RUNNING runs

The first claim of each daemon workflow is parked at its hold gate ("running",
elapsed climbing — screenshot one as evidence the hold works).

1. **Cooperative cancel**: row cancel on the parked run. Assert SQLite walks
   `running → cancel_requested → cancelling → cancelled`; orange Cancelled;
   the daemon SURVIVES (lockfile + `/whoami`) and claims the next queued run,
   which parks at the hold again — this is the first daemon-reuse proof
   (same `workerId` in the two `item_start` session events).
2. **Operation tree cancel**: cancel one oath-signature/EC operation row with
   scope `tree` — assert the delegated OCR child is cancelled with it; with
   default scope assert the child does NOT cascade (current contract —
   verify the UI makes this legible; if it reads wrong, that's a ledger issue,
   not a code change now).
3. Keep exactly one survivor per variant running/parked for Phase 4.

## Phase 4 — Run survivors to completion

1. For each awaiting-review survivor: open Preview, verify extracted rows
   against the fixture PDF (names/EIDs/selection defaults — preview-correctness
   lens), screenshot, **Approve** through the real UI.
   - Standalone OCR (oath/ec): approve must REJECT LOUD (no approve flow);
     verify the error surfaces in the UI and the run terminalizes as designed.
     Verify-mode approval ≡ delegation per current contract.
2. Remove hold gates one workflow at a time, observing each survivor walk its
   real steps in the session card (step chips advance; `step_change` events).
3. Assert completions:
   - oath-signature/EC operations: fanned-out children are `operation-member`
     rows parented to the coordinator, rendered inline under it; member data
     carries the OCR-extracted name/EID (data-travel lens); statuses `done`
     with `Dry Run Complete` where dryRun.
     - Member identity (person kind): each member's title is the RESOLVED name
       and its subtitle is the EID (EID-else-trace rule — present here because
       the OCR data stamps `emplId`), NOT `operation-member`-as-batch-member.
     - Each member's raw trace id composes the operation's exact `<code>-<HHMMSS>`
       prefix (`os-` for oath-signature, `ec-` for EC) — the SAME prefix the
       operation row and the delegated OCR review row carry (root trace-id
       propagation across the whole operation tree).
     - Group anchor: the coordinator surface is `kind:"operation"` with
       `memberCount` === the number of fanned-out members (e.g. 3 for a
       3-signer `multiple-oath.pdf`); the members render inline under it, not as
       a separate batch-queue page.
     - No-orphan: every child of the operation run (`parentRunId` ===
       operationRunId) is EITHER the delegated OCR review row OR an expected
       member — no stray third row under the coordinator.
   - **onbase operation** — same operation-coordinator shape as oath-signature/EC:
     - Operation coordinator is ROOT (`parentRunId` null); the delegated OCR
       review row is parented to it (`parentRunId` === onbaseOperationRunId) and
       appears as the ONE real row in the OCR panel (never duplicated in the
       OnBase panel).
     - The OCR review row uses form spec `onbase-emergency-contact`; `approveTo`
       fans `operation-member` rows to the `onbase` daemon. Approve through the
       UI; the onbase daemon has a stub handler (registered at b40abf93), so
       `operation-member` rows reach `done` (dryRun ON → `data.status === "Dry Run Complete"`).
     - On approval, `operation-member` rows fan out parented to the coordinator,
       exactly as EC/oath-signature. Trace prefix `ob-` propagates to every row
       in the tree: coordinator `ob-<HHMMSS>-<runId4>`, OCR review child
       `ob-<HHMMSS>-<childRunId4>`, each `operation-member` `ob-<HHMMSS>-<memberRunId4>`.
     - Per-member stub data contract (from `onbaseScript` in
       `src/core/e2e/stub-workflows.ts`): `authenticate` stamps `ucpathId`,
       `employeeName`, `documentType`, `sourcePage`; `fill-keywords` stamps
       `keysetAutofilled: "true"`; `import` stamps `status: "Dry Run Complete"` (dryRun)
       or `status: "Imported"` (non-dry-run). Assert these fields are visible in
       each member row's detail panel.
     - Member identity: title is the employee name (`employeeName` from OCR,
       resolved via the `onbase-emergency-contact` form spec which reuses the EC
       extractor); subtitle is the EID.
     - No-orphan: every child of the onbase operation run is EITHER the delegated
       OCR review row OR an expected `operation-member` row. No stray third row.
     - **OnBase is NOT registered for Capture mode** — the Phase 1b capture
       assertions do not apply to onbase. Do not attempt a capture-path onbase
       run.
   - OCR verify: person-lookup (+ i9-lookup) delegated rows exist under the
     OCR parent, `parentRunId` set, trace ids share the root prefix, stub
     lookup data stamped (`E2E Department` etc.), `e2eStub:"true"` on every
     stub row (provenance audit).
   - oath-upload: `wait-signatures` resolves only after ALL its signer rows are
     done; ticket stamps `DRY RUN - not submitted` (dryRun ON) — `HRC0E2E001`
     means the dryRun toggle didn't reach the input: ledger issue.
     - Single-row identity held step→step: the ONE born ticket row stays
       `single` / file-kind / ROOT (`parentRunId` null) / PDF-filename title /
       `ou-` trace prefix at EVERY step it walks (`wait-approval` →
       `wait-signatures` → … → terminal) — the same row advances, it is never
       re-shaped or re-parented.
     - NO fan-out twin: a FULL born-at-upload run files its OWN ticket, so the
       once-per-document `approveDocumentTo` ticket fan-out is SUPPRESSED.
       Assert EXACTLY ONE oath-upload row exists for the run (the born ticket) —
       no second oath-upload child appears under it across the whole lifecycle
       (the ticket's children are only the delegated OCR review + the signer
       rows it waits on, never a duplicate oath-upload ticket).
   - Failure modes to actively check: a cancelled signer (from Phase 2/3 picks)
     must make its oath-upload throw `NOT filing` rather than file.
4. **Organic failure → retry (the fail-injection matrix).** Retry was
   historically never exercised end-to-end; one leg also under-covers it. Arm a
   one-shot **fail gate** at a representative in-flight step for **≥1 workflow per
   daemon family** (e.g. `oath-signature--fail-at--transaction`,
   `oath-upload--fail-at--<a-step-after-the-ticket>`,
   `person-lookup--fail-at--active-status`) BEFORE releasing each survivor's
   hold — write an empty file
   `<trackerDir>/e2e-gates/<workflow>--fail-at--<step>.fail` (helper
   `e2eGateFailPath`, consumed by `core/e2e/gates.ts`). Per-family breadth matters
   because the "a failed step stamps no success data" invariant is step-specific —
   one global leg can't prove it where the families' step data differs. Vary the
   fail step so at least one is NOT the first step (proves partial-progress rows
   don't stamp the failed step's success data).

   **Failure KIND, not just location.** Today the gate throws
   `E2EScriptedFailError` (a clean exception). Two failure kinds it does NOT yet
   model — file each as a finding if it surfaces, and treat the mechanism gap
   itself as a deferred improvement: (a) **bad-data failures** — exercise these
   now by deliberately feeding a known-malformed fixture (the EC PDF whose
   `emergencyContact.address` is a bare string is the live example — VL-003 — it
   must surface as a visible "schema validation dropped N records", never a
   silent shrink of the approvable set); (b) **mid-step interruption** (network
   drop / auth expiry) — a `--fail-at--<step>.<kind>` gate variant would inject
   these deterministically; until it exists, note the coverage gap in the
   handoff. Most of this matrix belongs in the deterministic daemon-soak
   (`tests/delegation/`) — the e2e leg confirms only that each failure SURFACES
   correctly in the UI (red badge, banner, Retry button). Release the hold → the
   scripted step throws `E2EScriptedFailError` (a genuine non-cancel failure, NOT
   the cancel sentinel) the first time it reaches that step. Assert: SQLite task
   `failed`;
   terminal JSONL row `status:"failed"` with NO `step:"cancelled"`; UI shows the
   **red Failed** badge (NOT orange Cancelled) + the failure banner + a **Retry**
   button (queued/cancelled rows have no Retry; done/failed do). Click Retry
   (`/api/retry`) → the kernel replays `tasks.original_input_json` (NOT
   accumulated tracker data — pin that the replayed input equals the original).
   The gate self-consumed on the first fire, so the replay walks every step to
   `done`. Assert the retried run is a NEW run id born at "now", carries the same
   logical input, and completes with `Dry Run Complete`. (Pick a fail step that
   is NOT the first step so you also prove the partial-progress row didn't stamp
   the failed step's success data.)
5. Full API dump + screenshots of every panel in final state (failed-then-retried
   row included).

## Phase 5 — Parallel workers (dedicated)

Fresh document: upload `multiple-oath.pdf` to oath-signature with
**workers = 3**, hold gate ON, approve its OCR so ≥3 signer rows fan out
(use a 6-signer fixture if available; else enqueue extra EID input runs to
deepen the queue).

1. **Spawn exactly N**: 3 lockfiles, 3 session cards, `/whoami` matches; never
   a 4th while the queue is deep.
2. **Distribution + reuse**: with the hold released, ≥1 `workerId` appears on
   ≥2 `item_start` events (reuse proof from `sessions/*.jsonl`, not eyeballs).
3. **Auto reuses, never overspawns**: second run with workers = Auto →
   zero new lockfiles; alive daemons absorb the work.
4. **Add-worker mid-run must NOT steal the in-flight item (lease-renewal
   regression — the reported bug).** With ONE worker on a deep queue, clicking
   the session-panel **"+"** (`AddWorkerButton` → `/api/daemons/spawn`) used to
   make the NEW worker re-pend and re-run the item the first worker was already
   processing (double execution against the real system). Reproduce through the
   UI: one daemon (workers = 1) parked mid-step on worker A via the hold gate,
   with **≥1 more item still `queued`** behind it. Capture A's in-flight task X
   from `/api/tasks` — record `claimed_by_worker_id` (= A), `control_state`
   (`running`/`claimed`), and **`claim_generation`**. **Wait past the 60s
   claim-lease window (~65s — load-bearing):** the lease is `claim_expires_at =
   claim + 60s`, and the theft only fires once it expires; nothing renewed it
   before the fix, so a peer's startup/keepalive recovery re-pended a
   still-running item. Then click **"+"** → add ONE oath-signature worker (stub
   daemon B spawns, no Duo). After B is alive and has run its startup recovery,
   assert:
   - **X is still owned by A** — `/api/tasks` shows X `control_state` unchanged
     and `claimed_by_worker_id` still A, with **`claim_generation` UNCHANGED**
     (a re-pend via `returnTaskToQueued` bumps it — any increment here IS the
     bug).
   - **B never started X** — no second `item_start` for X under a different
     `workerId` in `sessions/*.jsonl`; X never flips back to a pending/queued
     surface in `debug/row-lifecycle-*.jsonl` (exactly one running surface, one
     terminal later).
   - **B takes real queued work instead** — B claims a DIFFERENT queued item, or
     sits idle if none remain.
   - Release the hold → X completes **once** under worker A (one terminal row,
     one done badge); no duplicate/conflicting run for X, and B now legitimately
     shares the remaining queue.
   This exercises the heartbeat lease-renewal (`taskStore.renewClaim` on each
   ~5s worker heartbeat keeps a live worker's lease fresh, so recovery never
   treats its in-flight item as orphaned). Deterministic red→green pin:
   `tests/unit/core/task-store.test.ts` (`renewClaim` cases). A `claim_generation`
   bump on X, or any second `item_start` for X, is **high** severity.
5. **Stop-instance reassign (the user's headline case)**: hold ON so an item is
   parked mid-step on worker A; session-card Stop on A
   (`/api/daemon/stop-instance`, reassign semantics). Assert: task returns to
   `queued` (pending row re-emitted, NOT failed/cancelled), peer B claims it
   (different `workerId`, same runId continuity per current contract), run
   completes after release. A's lockfile is gone.
6. **Stop All** (`/api/daemon/stop`): in-flight items fail RED (no `cancelled`
   sentinel — that's the designed distinction), queued items terminalized by
   the last daemon, zero orphan lockfiles after.
7. Note (don't wait out) the 15-min idle timeout; verify cards show idle state.

## Phase 6 — Resilience spot-checks

1. Reload :5173 mid-run (something running) → state rehydrates from SSE/API:
   same rows, statuses, session cards, no duplicates, no lost trace ids.
2. Counts triangle: rail `wfCounts` ≡ backend SSE payload ≡ hand-counted
   visible top-level rows, including delegated-collapse + still-rendered
   resolved OCR preps.
3. `debug/row-lifecycle-*.jsonl`: no surface misclassifications, no
   stuck-retry loops, every run reaches a terminal surface exactly once.
4. Log panel for 3 sampled runs (one per family): logs attributed to the right
   runId, structured fields present, no `[jsonl] skipping invalid line` spam
   anywhere in backend output.
