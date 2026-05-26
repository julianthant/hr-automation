# Oath Signature Workflow

Add a new **Oath Signature Date** row to a UCPath Person Profile for one or
more employees.

**Kernel-based + daemon-mode.** Declared via `defineWorkflow` in `workflow.ts` and enqueued from dashboard input runs (`InputRunPanel` → `/api/enqueue`) or PDF upload (`RunModal` → `/api/oath-signature/start`).

## Dual input shape (Plan A Commit 3)

The workflow's schema is a `z.discriminatedUnion("kind", [...])`:

  - **`{ kind: "signer", emplId, name?, date?, dryRun? }`** — per-EID flow.
    One row, one UCPath transaction. Each input is independent — daemon
    mode enqueues 1:1 and processes sequentially on one browser. Input-run
    typing or fan-out children from a PDF run produce these.
  - **`{ kind: "pdf", pdfPath, pdfOriginalName, sessionId, rosterMode?, rosterPath?, dryRun? }`** —
    paper-roster flow. The handler delegates to the `ocr` workflow (which
    suspends until operator approval under the clean-terminal contract),
    reads the approved records, and `delegateToAll`s back into this workflow
    with N `kind: "signer"` inputs. The discriminator gates the recursion —
    fan-out children always enter the signer branch.

`archetype` is a resolver: `batch` for `kind: "pdf"`, `single` for
`kind: "signer"`. The PDF row renders as a batch parent in this workflow's
tab; signer rows live in the same tab as either single rows (N=1) or batch
members under the PDF row's batch (N≥2).

## Step list

Both branches share `["ocr", "fan-out", "ucpath-auth", "transaction"]` and use
`ctx.skipStep` for the steps they don't exercise:

  - Signer branch: skips `ocr` + `fan-out`; runs `ucpath-auth` (markStep) +
    `transaction` (real PeopleSoft work).
  - PDF branch: runs `ocr` (`ctx.delegateTo(ocrWorkflow, ...)`) + `fan-out`
    (`ctx.delegateToAll(oathSignatureWorkflow, signerInputs, { renderAs: "batch" })`);
    skips `ucpath-auth` + `transaction`.

## What this workflow does

Given one or more EIDs, for each EID:

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

- `schema.ts` — `OathSignatureInputSchema` (EID required; optional `date`, `dryRun`, delegation fields)
- `enter.ts` — `buildOathSignaturePlan` ActionPlan + `OathSignatureContext`
- `workflow.ts` — `defineWorkflow`, `runOathSignature`, `runOathSignatureCli`
- `config.ts` — `UCPATH_PERSON_PROFILES_URL` deep link
- `index.ts` — Barrel exports

(Removed 2026-05-01: `prepare.ts`, `preview-schema.ts` — prep is owned by the **`ocr`** workflow + `src/tracker/dashboard/hono/routes/ocr.ts`.)

## Dashboard-contract scenario tests

`tests/scenarios/oath-signature/` covers the row lifecycle the dashboard
renders — `happy-path-single`, `cancel-during-transaction`, `fail-during-transaction`,
`retry-after-failure`, `multi-eid-batch`. Each test runs the real kernel + tracker
with a scripted handler (no browser, no UCPath calls) and locks the row
snapshot via `expect(snap).toMatchInlineSnapshot()`. Read
`tests/scenarios/CLAUDE.md` for the harness and `_beats.ts` for the beat
builder before changing handler step structure — drift will fail snapshots.

## Kernel Config

| Field         | Value                                                                          | Why                                                                                   |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `systems`     | `[ucpath]`                                                                     | One auth domain, one Duo.                                                             |
| `steps`       | `["ocr", "fan-out", "ucpath-auth", "transaction"]` — PDF runs exercise `ocr` + `fan-out`; signer runs skip those and perform `ucpath-auth` + `transaction` |
| `schema`      | `{ emplId, date?, dryRun?, … }` — see `schema.ts`                                                            |
| `batch`       | `{ mode: "sequential", preEmitPending: true, betweenItems: ["reset"] }` | Daemon reuses the browser across items; `reset` prevents page-state leak.   |
| `tiling`      | `"single"`                                                                     | One browser window.                                                                   |
| `authChain`   | `"sequential"`                                                                 | Single system, no chain to interleave.                                                |
| `detailFields`| Employee / Empl ID / Signature Date                                            | Dashboard detail panel populates via `ctx.updateData` in the handler.                 |
| `archetype`   | `"single"` — each EID is independent. When dispatched as a child run from oath-upload, the kernel stamps `delegate-child`. |

### Row archetypes emitted

| Row                                  | Archetype         | Dashboard surface                |
|--------------------------------------|-------------------|----------------------------------|
| Direct input run per-EID             | `single`          | Flat queue row                   |
| Child run dispatched from oath-upload | `delegate-child`  | Nested under oath-upload's card  |
| Child run dispatched from PDF branch fan-out | `delegate-child` | Nested under oath-signature PDF row |

## Data Flow

```
InputRunPanel → /api/enqueue
  → enqueueFromHttp
    → ensureDaemonsAndEnqueue(…)
      - Validates every {emplId, date?} via schema
      - Inserts one SQLite task row per EID and appends enqueue audit to .tracker/daemons/oath-signature.queue.jsonl
      - Pre-emits `pending` tracker row per EID (dashboard populates instantly)
      - Wakes alive daemons; spawns one when none is alive (Duo 1×/daemon)
      - Each daemon pulls from the queue:
          • reset browser to about:blank (betweenItems)
          • handler → plan.execute() → add oath → OK → Save → return-to-search
          • dupe-protection: skip add/save if the existing-oath sentinel
            is absent on profile load (live-page probe)

In-process path (tests/scripts — call runOathSignature directly):
  → runWorkflow(oathSignatureWorkflow, input)
```

## Dupe-protection

Single guard (tracker-side idempotency removed 2026-04-23):

- **Live page probe** — if the profile doesn't show the "no oath signature
  date" sentinel on load, the plan skips the add/OK/Save steps and marks
  the item `Skipped (Existing Oath)`. The existing-oath state on the live
  profile is the source of truth; a retry against the same EID converges
  correctly without a tracker-side cache.

## Capture integration (mobile-photo entry)

`makeCaptureFinalize(trackerDir)` (`src/tracker/dashboard/capture-state.ts`) maps `workflow: "oath-signature"` to `enqueueOathSignaturePdf`, the same `{ kind: "pdf" }` enqueue helper behind `/api/oath-signature/start`. The PDF path comes from bundled photos under `.tracker/uploads/`.

## Dashboard — OCR prepare + approve (oath form type)

Paper-roster **prep** is not separate HTTP under this folder anymore. Select workflow **`oath-signature`** in the TopBar Run modal (or finish a **Capture** session — see above); the dashboard POSTs to **`/api/oath-signature/start`** with a PDF, which enqueues one `{ kind: "pdf" }` oath-signature run. That PDF branch delegates to shared OCR with `formType: "oath"`. Orchestration, roster match, eid-lookup fan-out, `/api/ocr/approve-batch`, and stuck-row sweeps live under `src/tracker/dashboard/ocr/` + `src/tracker/ocr-http.ts` (see **`src/workflows/ocr/CLAUDE.md`**).

Oath OCR approve does **not** fan out from the approve route. The approve route only writes the terminal OCR row (`done step=approved`) and wakes this workflow's PDF branch; the PDF branch reads the approved records and `ctx.delegateToAll`s `{ kind: "signer", emplId, name?, date? }` children. Parent prep rows use `data.mode === "prepare"`; eid-lookup delegation uses item ids prefixed **`oath-prep-`** so they do not collide with emergency-contact prep.

### Shared roster + match primitives

OCR handlers import **`src/services/matching/`** for roster load + name match — shared with other workflows.

## Gotchas

- **Iframe id differs from Smart HR** — see above. Using `#main_target_win0`
  here returns an empty frame and everything times out.
- **Return-to-Search retains the EID.** The search form re-renders with the
  prior Empl ID populated between iterations; `searchByEmplId` clears the
  field before filling it to avoid EID concatenation.
- **Direct Person Profile URL can reopen on the prior profile.** PeopleSoft
  sometimes preserves the last loaded detail page even after navigating to the
  Person Profiles component URL. `navigateToPersonProfiles` must verify the
  Empl ID search textbox is visible and click **Return to Search** when the
  detail page is still rendered; `returnToSearch` must also wait for the
  search textbox before the next daemon item starts.
- **Two "Add New Oath Signature Date" anchors** exist (icon + text link)
  with the same accessible name. The selector anchors on the PeopleSoft id
  `DERIVED_JPM_JP_JPM_JP_ADD_CAT_ITM$41$$0` first, falling back to
  `getByRole("link", ...).first()`.
- **Unsigned rows in OCR prep.** The OCR orchestrator keeps every extracted row in the prep payload; unsigned rows stay deselected so operators can catch a mis-read signature column without re-uploading.

## Lessons Learned

- **Lesson maintenance rule:** Search this section, `src/workflows/ocr/CLAUDE.md`, and `src/systems/ucpath/LESSONS.md` before adding oath-signature guidance. Merge old OCR-prep notes into the current shared-OCR model instead of preserving obsolete grouped-upload behavior.
- **2026-05-26: Oath approve-side fan-out retired.** Oath's OCR form spec intentionally omits `approveTo`. `/api/ocr/approve-batch` writes the terminal OCR row and emits the approval signal only; it does not enqueue `oath-signature` signer rows, mirror upstream rows, or create dependency rows. The PDF branch's `ctx.delegateToAll(oathSignatureWorkflow, signerInputs, { renderAs: "batch" })` is now the sole producer of signer children, which removes the duplicate-signer-batch hazard from the Plan A Commit 3 transition. Emergency-contact still uses approve-route fan-out through its own `approveTo`.
- **2026-05-25: Discriminated `{ kind: "signer" | "pdf" }` input.** Plan A Commit 3 collapsed the old PDF-upload-to-OCR-to-signer chain into a single workflow with two input variants. PDF uploads enqueue one oath-signature daemon item; its kernel handler delegates to OCR (suspends until approval), reads records, and fans out signer children via `ctx.delegateToAll`. Bare `{ emplId, ... }` shapes get wrapped at the adapter boundary for legacy in-process callers, while PDF fan-out children are explicitly `{ kind: "signer", ... }`.
- **2026-05-25: Dashboard input/upload runs are the public start paths.** `npm run oath-signature` is retired. Typed EID starts belong in `InputRunPanel`; paper-roster starts belong in the upload run / shared OCR path.
- **Person Profiles direct URL can preserve stale detail state.** After skipping an existing oath and returning to search, the next direct navigation may still render the prior profile. `navigateToPersonProfiles` / `returnToSearch` must verify the Empl ID search textbox and recover by clicking Return to Search when needed.
- **Paper-roster prep is owned by the shared OCR workflow.** Oath form type (`formType: "oath"`) routes through OCR and `src/services/ocr/forms/oath.ts`. This folder no longer owns `prepare.ts` or `preview-schema.ts`; the oath-signature PDF branch consumes approved OCR rows and enqueues `{ kind: "signer", emplId, date? }` children.
- **Duplicate protection is live-page only.** Tracker-side idempotency is gone. If the profile shows the "no oath signature date" sentinel, add/save; otherwise skip as existing. A retry converges on the live profile state.
- **Multi-file upload is N independent PDF runs.** Selecting N PDFs fires N separate oath-signature PDF starts with no shared parent id. Each PDF gets its own daemon item titled by PDF name; do not reintroduce a grouped upload card.
- **Prep rows do not need synthetic request members.** The main prep row already represents the OCR handoff in the queue panel. OCR-to-EID fan-out stays as delegation member rows; final oath-signature work rows are person rows titled by name when known, falling back to EID.
- **Hybrid match constants live in `src/services/ocr/forms/oath.ts`.** Form-EID short-circuits to roster exact/verify-only lookup, high-confidence roster names auto-accept, ambiguous names go through LLM disambiguation, and low-confidence/no-candidate rows require manual or EID lookup backstop.
