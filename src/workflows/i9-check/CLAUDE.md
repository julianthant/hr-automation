# I-9 Check Workflow

Search-only I-9 retention check: verify each person from a scanned I-9 packet
against UCPath and fill the operator's I-9 **retention tracking spreadsheet**.
Category **"Separations"** — it sits beside the Kuali termination workflow in
the rail, but it is its own workflow (**split out of separations 2026-07-17**;
it previously ran as a `mode: "i9-check"` input variant inside the separations
daemon, spinning 3 browsers and rendering the 7 termination steps as skipped on
every member row).

**1 browser — UCPath only.** `code: "ic"`, `inputSubject: "name"`, archetype
`single`, three handler steps (`person-match` → `person-lookup` →
`roster-match`), sequential batch with a reset to `UCPATH_SMART_HR_URL`
between items. This workflow mutates NOTHING: no Kuali, no Kronos, no UCPath
transaction modules — pinned structurally by
`tests/unit/architecture/i9-check-import-guard.test.ts` (sweeps every module in
this directory for banned imports).

## The flow (two phases)

**Phase 1 — OCR (delegated, auto-completes).** The operator uploads a scanned
I-9 packet via the panel's **"Run I-9 Check"** upload modal
(`RUN_MODAL_REGISTRY["i9-check"]`, `lockedFormType: "i9"`,
`targetWorkflow: "i9-check"`). `/api/ocr/prepare` creates an `i9-check`
**operation coordinator** row (`OPERATION_COORDINATOR_WORKFLOWS`, trace code
`ic`) and delegates the OCR run under it. The `i9` form spec
(`src/services/ocr/forms/i9.ts`) reads each page (Section 1: name/DOB/SSN;
Section 2: employer name line, **First Day of Employment** = "Hire Date (from
I-9)"), pairs each person's two — usually NON-adjacent — pages by name
(`corroborateI9Records`), and matches `PATHS.i9ActionHistoryPath`
(`data/rosters/Employee Action History Report….xlsx` via
`src/services/matching/employee-action-history.ts`) **BY NAME** for PPS EID /
roster Empl ID / separation date. Names are normalized to the title-cased
"Last, First M" display convention (`displayPersonName` inside
`buildI9DisplayName`) — a hand-printed "QIAO, WANHUI" renders "Qiao, Wanhui"
on the review pane, member rows, and the spreadsheet. **No UCPath search runs
during OCR.** The spec sets `completeDelegatedRun: true`, so the delegated run
completes `done` right after enrichment (no approve gate). A missing Action
History file fails loud during enrich.

**Phase 2 — i9-check member tasks (REAL daemon tasks, THIS workflow).** On
completion `/api/ocr/prepare` calls **`enqueueI9CheckMemberTasks`**
(`src/tracker/dashboard/ocr/i9-check-results.ts`): one i9-check task per
person, nested under the coordinator (`rowShape: "operation-member"`). The
coordinator stays **running** at fan-out — the members-terminal rollup
completes it. Each task runs `check.ts` (`runI9CheckMember`) as **three
kernel steps** (in-process primitives — not `ctx.delegateTo`):

1. **`person-match` (mandatory)** — `searchPerson` (HR-Tasks) when Section 1
   supplied SSN and/or DOB plus first+last. Missing identifiers → treat as
   **not-found** (skip the search) so the optional lookup can run. Ambiguous
   UI races still throw (never guess).
2. **`person-lookup` (optional)** — skipped via `ctx.skipStep` when
   person-match already resolved a unique Empl ID. Otherwise
   `lookupPersonInUcpath` by name (`keepNonHdh` — retention applies to every
   department), then **hire-date corroboration**
   (`selectPersonLookupByHireDate`): accept a Person Org candidate only when
   I-9 Hire Date (from I-9) is within **±7 days** of UCPath Last Hire
   (`startDate`, EFFDT fallback). No hire date → ambiguous / review (never
   accept a name-only hit). Zero ±7d hits → not-found; two+ → ambiguous.
3. **`roster-match` (mandatory)** — re-match Action History **BY the resolved
   EID** (`lookupActionHistoryRowByEmplId`); if that misses but OCR seeded a
   PPS (often a 5-digit zero-stripped "Employee PPS ID Current"), rematch **BY
   PPS** (`lookupActionHistoryRowByPpsId` — still no name fallback). Stamps
   `ucpathFound`/`eid`/`ppsEid`/`separationDate` on the member row — PPS ID and
   Separation Date are always on the detail grid (blank when neither rematch
   nor the OCR seed had them). Rematch wins; else the OCR name-match seed is
   kept for both the grid and the spreadsheet. The found/not-found chip
   (`i9CheckStatusExtensions`, `src/domain/i9-check-status.ts`) keys on
   `data.ucpathFound`; an AMBIGUOUS outcome stamps NO chip. Then **master
   retention-tracker append** — one row per person to `PATHS.i9CheckTrackerPath`
   (`src/tracker/exports/i9-check-tracker.ts`; default
   `data/reports/i9-check-tracker.xlsx`, single "I-9 Check" sheet, columns =
   Employee Name | PPS EID (zero-padded, text format) | UCPATH Employee ID |
   Hire Date (from I-9) | Separation Date | Found in UCPath? | Action |
   Reviewer Name | Notes). Action rule (`decideI9RetentionAction`,
   operator-confirmed): not found → Shred; found + separation more than **5
   years** past → Shred; within 5 years → Keep + "Shred on <sep + 5y + 1d>"
   note; ambiguous / no roster row / no separation date → blank Action +
   review-manually note (never guess). Reviewer Name = `getTimekeeperName()`
   (validated loudly at fan-out, before any enqueue). **Re-runs always
   APPEND** — dedupe the sheet manually.

## Retry safety

The old separations guard map (disjoint input union + `assertNotI9CheckShaped`
+ import guard) is now mostly **structural**: this workflow has no termination
handler to reach, so a retry can only re-run a search. What remains explicit:

1. **Schema** (`schema.ts`): the `mode: "i9-check"` literal keeps the payload
   self-describing; the separations termination schema REJECTS it outright
   (pinned by `tests/unit/workflows/i9-check/schema.test.ts`).
2. **JSONL-reconstruction refusal** (`src/control/ops/retry.ts`): an
   i9-check-flagged row (`data.i9Check === "true"`, workflow `i9-check` or
   legacy `separations`) with no SQLite task is REFUSED ("re-run the I-9
   upload") — the flat merged-strings rebuild cannot produce the nested
   person/roster input, and on legacy separations rows it would build a
   docId-shaped REAL termination input.
3. **Import guard** (`i9-check-import-guard.test.ts`): every module here may
   import only read-only search primitives.

## Fail-loud invariants (do not soften)

A fan-out that can't read the completed run's records **throws** and the
coordinator goes `failed` (never a silently empty operation). A page that names
NOBODY searchable becomes a **display-only failed row** (`data.displayOnly ===
"true"`, no task; `isDisplayOnlyRow` strips retry/cancel/bump). A **disputed**
field (Section 2 contradicts Section 1) is dropped from the search input, never
arbitrated; illegible fields are `null` + named in `record.illegible[]` — a
wrong digit searches UCPath for the wrong person and reads as a confident "not
found". An orphan Section 2 person gets a REAL name-only check task with a
warning naming the missing Section 1 page.

**Member rows carry their own logs.** The fan-out writes each pending member's
OCR provenance (page, extracting model, corroboration, **the criteria the
search will rest on** — never the SSN itself) against its own
`(workflow, itemId, runId)`; the daemon step then logs the search + verdict +
tracker append on the same row. The pre-emit pending row carries **no `input:`
block** (the SQLite task's `original_input_json` is the replay authority, and
the input holds the SSN).

## History

- **2026-07-17: split out of separations.** Formerly the `mode: "i9-check"`
  disjoint-union input variant of `src/workflows/separations/` (rev.
  2026-07-16). The separations daemon spun 3 browsers (Kuali/New Kronos/UCPath)
  for a UCPath-only search, and every member row rendered the 7 termination
  steps as skipped. Old separations member rows still on disk keep their chip
  via `separations-status.ts` re-exporting `i9CheckResultTag`; a legacy queued
  separations i9-check task now FAILS LOUD at schema parse (re-run the upload).

See `src/services/ocr/CLAUDE.md` (the `i9` form-spec entry, incl. the trust
model + second-opinion policy) and `src/tracker/exports/i9-check-tracker.ts`
(the retention-tracker writer + advisory lock).
