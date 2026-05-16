# Oath Signature Workflow

Add a new **Oath Signature Date** row to a UCPath Person Profile for one or
more employees.

**Kernel-based + daemon-mode.** Declared via `defineWorkflow` in `workflow.ts` and enqueued via `runOathSignatureCli` (`buildCliAdapter` → `ensureDaemonsAndEnqueue`). Supports N EIDs per invocation — each becomes its own queue item. `npm run oath-signature` exposes `-n`, `-p`, optional `--date`, and `--dry-run` (see `src/cli.ts`).

**OCR / prep:** Paper-roster flows run through the **`ocr`** workflow (dashboard TopBar → form type **`oath`**) — see `src/workflows/ocr/CLAUDE.md` and `src/workflows/oath-signature/ocr-form.ts` for schemas + hybrid match. Approved OCR runs pre-emit child rows and enqueue this workflow per `{ emplId, date? }`.

**Synthetic `ocr` step:** `workflow.ts` declares **`"ocr"`** as the first step; the handler calls `ctx.markStep("ocr")` (no browser work — a timeline marker so rows show upload → OCR → UCPath).

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

- `schema.ts` — `OathSignatureInputSchema` (EID required; optional `date`, `dryRun`, delegation fields)
- `ocr-form.ts` — OCR schemas + match logic when dashboard OCR uses **`formType: "oath"`**
- `enter.ts` — `buildOathSignaturePlan` ActionPlan + `OathSignatureContext`
- `workflow.ts` — `defineWorkflow`, `runOathSignature`, `runOathSignatureCli`
- `config.ts` — `UCPATH_PERSON_PROFILES_URL` deep link
- `index.ts` — Barrel exports

(Removed 2026-05-01: `prepare.ts`, `preview-schema.ts` — prep is owned by the **`ocr`** workflow + `src/tracker/dashboard/hono/routes/ocr.ts`.)

## Kernel Config

| Field         | Value                                                                          | Why                                                                                   |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `systems`     | `[ucpath]`                                                                     | One auth domain, one Duo.                                                             |
| `steps`       | `["ocr", "ucpath-auth", "transaction"]` — `ocr` is **`ctx.markStep` only** (timeline marker for OCR-sourced items); live work is `ucpath-auth` + `transaction` |
| `schema`      | `{ emplId, date?, dryRun?, … }` — see `schema.ts`                                                            |
| `batch`       | `{ mode: "sequential", preEmitPending: true, betweenItems: ["reset"] }` | Daemon reuses the browser across items; `reset` prevents page-state leak.   |
| `tiling`      | `"single"`                                                                     | One browser window.                                                                   |
| `authChain`   | `"sequential"`                                                                 | Single system, no chain to interleave.                                                |
| `detailFields`| Employee / Empl ID / Signature Date                                            | Dashboard detail panel populates via `ctx.updateData` in the handler.                 |

## Data Flow

```
CLI: npm run oath-signature <emplId...> [--date …] [--dry-run]   (daemon — default)
  → runOathSignatureCli (`buildCliAdapter`)
    → ensureDaemonsAndEnqueue(…)
      - Validates every {emplId, date?} via schema
      - Inserts one SQLite task row per EID and appends enqueue audit to .tracker/daemons/oath-signature.queue.jsonl
      - Pre-emits `pending` tracker row per EID (dashboard populates instantly)
      - Wakes alive daemons; spawns new ones up to --parallel N (Duo 1×/daemon)
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

`makeCaptureFinalize(trackerDir)` (`src/tracker/dashboard/capture-state.ts`) maps `workflow: "oath-signature"` to OCR **`formType: "oath"`** and invokes **`buildOcrPrepareHandler`** — same HTTP implementation as `/api/ocr/prepare` (`src/tracker/dashboard/hono/routes/ocr.ts`), with the PDF path coming from bundled photos under `.tracker/uploads/`.

## Dashboard — OCR prepare + approve (oath form type)

Paper-roster **prep** is not separate HTTP under this folder anymore. Select workflow **`oath-signature`** in the TopBar Run modal (or finish a **Capture** session — see above); the dashboard POSTs to **`/api/ocr/prepare`** and related routes in **`src/tracker/dashboard/hono/routes/ocr.ts`** with `formType: "oath"`. Orchestration, roster match, eid-lookup fan-out, `/api/ocr/approve-batch`, and stuck-row sweeps live under `src/tracker/dashboard/ocr/` + `src/tracker/ocr-http.ts` (see **`src/workflows/ocr/CLAUDE.md`**).

Approve still fans out **`oath-signature`** daemon queue items (`{ emplId, date? }`). Parent prep rows use `data.mode === "prepare"`; eid-lookup delegation uses item ids prefixed **`oath-prep-`** so they do not collide with emergency-contact prep.

### Shared roster + match primitives

OCR handlers import **`src/services/matching/`** for roster load + name match — shared with other workflows.

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
- **Unsigned rows in OCR prep.** The OCR orchestrator keeps every extracted row in the prep payload; unsigned rows stay deselected so operators can catch a mis-read signature column without re-uploading.

## Lessons Learned

- **2026-04-28: Paper-roster OCR prep migrated to the shared `ocr` workflow.** Oath form type (`formType: "oath"`) is handled by dashboard routes under `/api/ocr/*` (`src/tracker/dashboard/hono/routes/ocr.ts`); per-form schemas + match live in `ocr-form.ts`. Deleted workflow-local `prepare.ts` / `preview-schema.ts`. Parent rows still use `data.mode === "prepare"` where applicable; eid-lookup queue items use `oath-prep-` prefixes. Kernel input remains `{ emplId, date? }` per `OathSignatureInputSchema`.
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
- **2026-05-14: Batch-row redesign + label inheritance.** Oath-signature uploads now always render as a batch group (`Oath Signature · #<runIdSuffix>`) on the dashboard, regardless of OCR approval state. A new child row `Oath Signature Request` is emitted immediately after the OCR delegation is dispatched and reaches `done` as soon as the OCR session is queued. Cross-workflow delegated rows (OCR + EID-lookup children + post-approval oath-signature children) inherit the batch label via a new `data.parentSubject` channel — the receiving workflow's `onPreEmitPending` reads `parentSubject` and writes it into `data.__name`. Plan: `docs/superpowers/plans/2026-05-13-oath-signature-batch-row-naming.md`.
- **2026-05-03: Hybrid match (roster → LLM disambig) + form-EID short-circuit.** `matchRecord` is now async and runs in three branches: (1) form-EID (the LLM extracted an `employeeId` from a UPAY585/586) → roster-exact match auto-accepts as `matchSource: "form-eid"`, no roster match dispatches eid-lookup-by-EID via the new `LookupKind: "verify-only"`. (2) Name-only with top score >= 0.95 + no close second → auto-accept as `matchSource: "roster"`. (3) Top score in [0.40, 0.95) or close second → leaves `matchState: "lookup-pending"` with candidates populated; the orchestrator's `disambiguating` phase runs `disambiguateMatch` and `applyDisambiguation` patches the record (high-confidence ≥ 0.6 → `matchSource: "llm"` accepted; low confidence → `matchSource: "llm"` lookup-pending; null → `matchSource: "manual"`). Top < 0.40 / no candidates → `matchSource: "manual"` directly with eid-lookup-by-name as the backstop. The 0.95/0.10/0.40/0.6 constants live at the top of `ocr-form.ts`. Spec: `docs/superpowers/specs/2026-05-03-ocr-hybrid-match-and-manual-fill-design.md`.
