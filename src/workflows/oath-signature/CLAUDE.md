# Oath Signature Workflow

Add a new **Oath Signature Date** row to a UCPath Person Profile for one or
more employees.

**Kernel-based + daemon-mode.** Declared via `defineWorkflow` in `workflow.ts`
and executed through `src/core/runWorkflow` (single-item, `--direct`) or
enqueued to a daemon via `ensureDaemonsAndEnqueue` (default). Supports N EIDs
per invocation — each becomes its own queue item so a single daemon processes
them sequentially, and `--parallel K` fans out across K daemons.

## What this workflow does

Given one or more EIDs (plus an optional `--date MM/DD/YYYY`), for each EID:

1. Navigate to Person Profiles (direct URL).
2. Search by Empl ID (lands directly on the profile — EID is unique).
3. Extract the employee name and probe the page for an existing oath (the
   "There are currently no Oath Signature Date…" sentinel). If absent, skip
   add/save (live-page dupe-protection).
4. Click **Add New Oath Signature Date** → (optionally override the date)
   → **OK** → **Save**.
5. Click **Return to Search** so the browser is left on a clean search
   form for the next EID in the daemon queue.

## Selector Intelligence

This workflow touches: **ucpath**.

Before mapping a new selector, run `npm run selector:search "<intent>"`.

- [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
- [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md) —
  see the `oathSignature` group.
- [`src/systems/ucpath/common-intents.txt`](../../systems/ucpath/common-intents.txt)

### Iframe gotcha

Person Profile mounts inside `#ptifrmtgtframe` (name `TargetContent`), **not**
`#main_target_win0` used by Smart HR. The selector group exposes
`oathSignature.getPersonProfileFrame(page)` — use it instead of
`getContentFrame(page)`.

## Files

- `schema.ts` — `OathSignatureInputSchema` (`{ emplId, date? }`)
- `enter.ts` — `buildOathSignaturePlan` ActionPlan + `OathSignatureContext`
- `workflow.ts` — Kernel definition, CLI adapters (`runOathSignature`,
  `runOathSignatureCli`)
- `config.ts` — `UCPATH_PERSON_PROFILES_URL` deep link
- `preview-schema.ts` — Zod schemas for the paper-roster prep flow:
  `OathRosterOcrRecordSchema` (one row per signer), `OathOcrOutputSchema`
  (array, fed to `ocrDocument`), `MatchStateSchema`, `OathPreviewRecordSchema`
  (OCR record + match state + selection + warnings), `OathPrepareRowDataSchema`
  (parent prep row payload, `mode: "prepare"`).
- `prepare.ts` — `runPaperOathPrepare(input)` — OCR-then-match orchestrator
  for the dashboard "Run" button. Mirrors `emergency-contact/prepare.ts`:
  pending row → load roster → `ocrDocument(OathOcrOutputSchema)` → roster
  match (auto-accept ≥ 0.85) → enqueue eid-lookup for unmatched →
  progressive updates → done. Unsigned rows are kept in the records list
  with `matchState: "extracted"` and `selected: false` so the operator
  sees the full page (catches OCR misreads of the signed/unsigned column)
  but they never become approvable kernel inputs.
- `index.ts` — Barrel exports

## Kernel Config

| Field         | Value                                                                          | Why                                                                                   |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `systems`     | `[ucpath]`                                                                     | One auth domain, one Duo.                                                             |
| `steps`       | `["ucpath-auth", "transaction"]`                                               | Matches `work-study` — auth phase + the single PeopleSoft transaction.                |
| `schema`      | `{ emplId, date? }`                                                            | EID is required; `date` defaults to UCPath's today-prefill on the detail form.        |
| `batch`       | `{ mode: "sequential", preEmitPending: true, betweenItems: ["reset-browsers"] }` | Daemon reuses the browser across items; `reset-browsers` prevents page-state leak.   |
| `tiling`      | `"single"`                                                                     | One browser window.                                                                   |
| `authChain`   | `"sequential"`                                                                 | Single system, no chain to interleave.                                                |
| `detailFields`| Employee / Empl ID / Signature Date                                            | Dashboard detail panel populates via `ctx.updateData` in the handler.                 |

## Data Flow

```
CLI: npm run oath-signature <emplId...> [--date MM/DD/YYYY]   (daemon — default)
  → runOathSignatureCli
    → ensureDaemonsAndEnqueue(oathSignatureWorkflow, inputs, { new, parallel })
      - Validates every {emplId, date?} via schema
      - Appends one enqueue event per EID to .tracker/daemons/oath-signature.queue.jsonl
      - Pre-emits `pending` tracker row per EID (dashboard populates instantly)
      - Wakes alive daemons; spawns new ones up to --parallel N (Duo 1×/daemon)
      - Each daemon pulls from the queue:
          • reset browser to about:blank (betweenItems)
          • handler → plan.execute() → add oath → OK → Save → return-to-search
          • dupe-protection: skip add/save if the existing-oath sentinel
            is absent on profile load (live-page probe)

CLI: npm run oath-signature:direct <emplId> [--date MM/DD/YYYY]   (legacy in-process)
  → runOathSignature — single EID only
    → if --dry-run: ActionPlan.preview() — prints the 8-step plan, no browser
    → else: runWorkflow(oathSignatureWorkflow, input)
```

## Dupe-protection

Single guard (tracker-side idempotency removed 2026-04-23):

- **Live page probe** — if the profile doesn't show the "no oath signature
  date" sentinel on load, the plan skips the add/OK/Save steps and marks
  the item `Skipped (Existing Oath)`. The existing-oath state on the live
  profile is the source of truth; a retry against the same EID converges
  correctly without a tracker-side cache.

## Digital-mode lookup (deferred — needs live CRM mapping)

The original 3-feature plan included a digital path: instead of a paper
roster, the operator pastes a list of EIDs and the workflow looks up
each oath signature date in CRM's "Show Onboarding History" view. The
date sample format (per the operator):

```
4/27/2026 1:26 PM    Wendy Chen    ProcessStageText    Witness Ceremony Oath Created    Witness Ceremony Oath New Hire Signed
```

The row to find is the one whose final column reads
`Witness Ceremony Oath New Hire Signed`; the first cell is the
`MM/DD/YYYY` date the workflow needs.

**Status: backend NOT shipped.** The `runPaperOathPrepare` flow handles
the paper case; for the digital case we need:

1. Live CRM playwright-cli session against a known EID (e.g. 10873611,
   Jasmine Ochoa) to map:
   - The path from CRM landing → View Onboarding Record (search by EID,
     or whatever the actual nav is — current `searchByEmail` uses
     `ONB_SearchOnboardings?q=<email>`; whether `?q=<eid>` works is
     unverified)
   - The "Show Onboarding History" button selector (likely
     `getByRole("button", { name: /show onboarding history/i })`)
     plus its target — does it open a modal, a new tab, or expand
     in place?
   - The history table row format and the date cell selector
2. Register selectors in `src/systems/crm/selectors.ts` under a new
   `onboardingHistory` namespace + bump `// verified` dates
3. Implement `lookupOathSignatureDate(page, emplId)` in
   `src/systems/crm/onboarding-history.ts` that returns the date
   string or `null`
4. Implement `runDigitalOathPrepare(emplIds, options)` that:
   - Launches a CRM kernel session via the existing `loginToACTCrm` flow
     (1 Duo)
   - For each EID: `lookupOathSignatureDate` → push an
     `OathPreviewRecord` with `matchState: "matched"`,
     `matchSource: "form"` (already-known EID), `dateSigned: <date>`
   - Reuses the same `OathPrepareRowData` schema → reuses the same
     `OathPreviewRow` UI for review/approve
5. HTTP endpoint `POST /api/oath-signature/digital-prepare` and a
   `TopBarDigitalPrepareButton` next to the Capture button
6. CLI: `npm run oath-signature:digital <emplId> [emplId ...]`

The shared schema + UI mean approval / fan-out is already wired —
digital-mode plugs in at the prepare phase only.

## Capture integration (mobile-photo entry)

`src/capture/` is the alternate entry point: instead of uploading a
pre-scanned PDF, the operator can click "Capture" on the dashboard, scan
a QR code on their phone, and snap photos of each signed roster page.
When the operator taps Done, capture bundles the photos into a PDF and
fires its `onFinalize` callback. The dashboard's
`makeCaptureFinalize(dir)` routes any session with
`workflow: "oath-signature"` straight into `runPaperOathPrepare` — the
same code path the file-upload "Run" flow uses, just with the PDF
arriving from `.tracker/uploads/<sessionId>.pdf` instead of a multipart
form.

## Dashboard "Run" button (paper-roster prep)

Mirrors emergency-contact's prep flow. The operator uploads a scanned
paper roster PDF, the dashboard OCRs it, matches each signed row against
the SharePoint onboarding xlsx, and (for unmatched rows) fans out into
the eid-lookup daemon to recover EIDs. Once all rows reach a terminal
match state, the operator reviews/edits per-row date, deselects any rows
they don't want, and clicks **Approve** — N kernel queue items fan out,
one per `{ emplId, date? }`.

```
TopBar Run button (oath-signature)
  → upload PDF (no rosterMode field — the SharePoint onboarding xlsx is
    the only matching source)
  → POST /api/oath-signature/prepare (multipart, fire-and-forget)
    → runPaperOathPrepare in src/workflows/oath-signature/prepare.ts:
      - synchronous: writes pending tracker row → loads newest .xlsx in
        .tracker/rosters/ (or src/data/) → OCR via src/ocr/
      - synchronous: per-row match (signed + roster name match >= 0.85)
      - async: enqueue eid-lookup daemon for unmatched signed rows;
        watches eid-lookup JSONL for completions, patches records progressively
      - terminal status: done (writes the records list to data.records)
  → PreviewRow renders at the top of the QueuePanel (data.mode === "prepare")
  → Operator reviews/edits each row inline (date editable; selected toggle)
  → POST /api/oath-signature/approve-batch:
    - validates each OathPreviewRecord, requires matched/resolved + valid EID
    - builds OathSignatureInput[] (`{ emplId, date? }`) — dateSigned (if any)
      becomes the kernel's `date` field
    - enqueues via enqueueFromHttp → ensureDaemonsAndEnqueue (auto-spawn if needed)
    - marks prep row `done` step `approved`
  → N child queue rows fan out; daemon claims them one at a time
```

Backend handlers live in `src/tracker/oath-signature-http.ts`. Same
single-workflow scoping as emergency-contact: parent prep row and child
per-EID rows both carry `workflow: "oath-signature"`; the discriminator
is `data.mode === "prepare"` on the parent. Restart sweep:
`sweepStuckOathPrepRows(dir)` runs at dashboard startup and marks any
prep row in pending/running as failed (the OCR + eid-lookup polling
lives in the dashboard's Node process, so a backend restart leaves any
in-flight prep row orphaned).

EID-lookup item-id prefix is `oath-prep-` (vs emergency-contact's
`ec-prep-`), so the two prep flows can run concurrently without seeing
each other's completion events when watching the same eid-lookup JSONL.

### Shared roster + match primitives

`prepare.ts` imports `findLatestRoster`, `loadRoster`, and
`matchAgainstRoster` from `src/match/` — a shared module that holds
roster xlsx loading, name matching (with Levenshtein), and US address
normalization. emergency-contact also consumes it. See `src/match/index.ts`
for the full export surface.

## Gotchas

- **Iframe id differs from Smart HR** — see above. Using `#main_target_win0`
  here returns an empty frame and everything times out.
- **Return-to-Search retains the EID.** The search form re-renders with the
  prior Empl ID populated between iterations; `searchByEmplId` clears the
  field before filling it to avoid EID concatenation.
- **Two "Add New Oath Signature Date" anchors** exist (icon + text link)
  with the same accessible name. The selector anchors on the PeopleSoft id
  `DERIVED_JPM_JP_JPM_JP_ADD_CAT_ITM$41$$0` first, falling back to
  `getByRole("link", ...).first()`.
- **Unsigned rows are kept in the prep payload.** `runPaperOathPrepare`
  returns *every* OCR'd row, including ones where `signed === false`.
  They land as `matchState: "extracted"`, `selected: false`, never get a
  roster lookup, and are filtered out of the approve fan-out. Keeping
  them gives the operator a full picture of what the OCR saw — if the
  LLM misreads a column, the row will appear deselected and the operator
  can flip the toggle rather than re-uploading.

## Lessons Learned

- **2026-04-28: Paper-roster OCR-prep flow shipped (extends emergency-contact's
  pattern).** New `src/workflows/oath-signature/{preview-schema,prepare}.ts`
  + `src/tracker/oath-signature-http.ts` mirror emergency-contact's prep
  shape. Same `data.mode === "prepare"` discriminator on the parent row,
  same single-workflow scoping (parent + children both
  `workflow: "oath-signature"`), same fan-out-on-approve. Differences:
  rosterMode is fixed (always xlsx in `.tracker/rosters/` or `src/data/` —
  the SharePoint onboarding spreadsheet); unsigned rows surface as
  deselected so the operator can spot OCR misreads of the signature
  column; eid-lookup itemId prefix is `oath-prep-` (so concurrent
  emergency-contact + oath-signature prep flows don't collide on the
  shared eid-lookup JSONL); kernel input is `{emplId, date?}` per
  `OathSignatureInputSchema`. Cross-workflow imports of
  `roster-loader.ts` + `match.ts` from emergency-contact (second
  consumer; the rule is "promote when there are three"). Async EID
  resolution chain reuses the same prep-watch-eid-lookup pattern.
- **2026-04-23: Removed tracker-side idempotency guard; only the live-page
  probe remains.** `src/core/idempotency.ts` was deleted repo-wide. The
  earlier two-guard design (live-page sentinel + `hashKey({workflow,
  emplId, date})` → `hasRecentlySucceeded`) collapses to one guard: if the
  profile shows "no oath signature date" on load, add + save; otherwise
  skip with `status: "Skipped (Existing Oath)"`. The live profile is the
  source of truth — a retry against the same EID converges correctly
  without a tracker-side cache.
- **2026-04-22: Initial implementation.** Mapped on EID 10873075 (Liam
  Kustenbauder). End-to-end live run verified: search → add → OK → save →
  return-to-search. Daemon mode wired from day one to match `work-study` /
  `separations`; multi-EID dispatch works out of the box because
  `ensureDaemonsAndEnqueue` accepts an input array.
