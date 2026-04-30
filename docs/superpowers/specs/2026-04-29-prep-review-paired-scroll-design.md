# OCR + Roster Method, Bento Prep Row, Paired-Scroll Review — Design

**Date:** 2026-04-29
**Status:** Approved (brainstorm phase). Implementation plan to follow.
**Affects:** `emergency-contact`, `oath-signature`, the `eid-lookup` workflow (extension), and the dashboard prep + review surfaces. Also generalizes the prep pattern so future workflows can adopt it.

---

## 1. Summary

Two arcs in one spec, because they share scope:

1. **Generalize the prep pipeline into "the OCR + Roster Method"** — a named cross-workflow framework: pick roster (existing SharePoint xlsx OR download new) → OCR each PDF page (with multi-provider parallelism, PDF order preserved) → match name⇄EID against roster (algorithmic + LLM disambiguation for borderline cases) → verify each resolved EID in UCPath Person Org Summary (active + HDH dept + screenshot) → write a `mode: "prepare"` parent tracker row with the assembled records. Workflows plug in their OCR prompt, form fields, and approve fan-out shape.

2. **Replace the inline-expand review with a paired-scroll review pane that takes over the LogPanel.** Each record renders as one PDF page (left) + an editable form (right), scrolling in source-PDF order so the operator can match the on-screen pair to their physical paper pile. The prep row in the queue panel adopts the standard EntryItem bento shape; clicking it opens the review pane. Anomalies (unknown documents, missing fields, failed verifications, missing oath signatures) are surfaced as visible flags with page-location callouts the operator can use to find the offending paper.

Digital-mode oath (CRM lookup by EID list) drops out of the prep/review flow entirely and enqueues kernel items directly.

---

## 2. Background

**Today's prep flow** (EC and oath both followed this pattern):
1. Operator clicks Run/Capture → uploads PDF.
2. Backend `runPrepare` / `runPaperOathPrepare` writes a `mode: "prepare"` tracker row (parent), runs OCR + roster match, enqueues unresolved names into the eid-lookup daemon, watches eid-lookup JSONL for completions, patches records progressively, eventually marks the row `done`.
3. Frontend `PreviewRow` / `OathPreviewRow` pins the parent row above the regular queue; operator clicks "Review & approve" to expand an inline records list inside the row, edits per-record fields, clicks Approve, and N kernel queue items fan out.

**What's wrong with it (operator pain that drove this redesign):**
- Inline-expand is cramped (320 px panel) for 12-30 records.
- No source-PDF preview alongside the editable fields — operator has to mentally cross-reference handwriting against form fields.
- No cross-check that the resolved employee is actually active in HDH; an EID resolved via roster might belong to someone who left the org months ago.
- No explicit indicator that a field was blank on the paper but auto-filled — operator can't tell what to write back on the physical form.
- No anomaly flag for pages that don't match any known form template (operator wants to spot wrong-pile inserts).
- "Review & approve" / "Resume" / "Reviewing" labels add ceremony without information.

**Existing infrastructure that stays:**
- Daemon-mode kernel fan-out on Approve.
- `enqueueFromHttp` plumbing; approve/discard endpoints per workflow.
- The capture flow (mobile-photo bundle → `runPaperOathPrepare`).
- `src/ocr/` multi-provider rotation.
- `src/match/` roster + name + address primitives.
- The eid-lookup workflow (extended; see §6).
- SharePoint download workflow + dashboard download dropdown.

---

## 3. The OCR + Roster Method (cross-workflow framework)

This is the named, reusable orchestration that any "paper-form-to-UCPath" workflow plugs into. EC and oath are the two consumers today; the framework is shaped so a third consumer is mostly form-field + OCR-prompt configuration.

### 3.1 Stages

```
upload PDF
    ↓
[stage 1] roster-source     — pick existing roster OR download new from SharePoint
    ↓
[stage 2] ocr               — per-page extraction; multi-provider parallel; PDF order preserved
    ↓                         ↳ also classifies documentType + flags originallyMissing
[stage 3] match             — algorithmic name⇄EID match against roster
    ↓                         ↳ LLM disambiguation when algorithmic confidence is borderline
    ↓                         ↳ verifies BOTH name and EID match between paper + roster
[stage 4] eid-lookup        — for records still missing EIDs, enqueue to eid-lookup daemon
    ↓                         ↳ resolves EID via Person Org Summary name search
[stage 5] verify            — for every record with an EID, verify in Person Org Summary
    ↓                         ↳ checks active hrStatus + HDH-accepted dept
    ↓                         ↳ captures Person Org Summary screenshot per record
ready → operator review → approve fan-out
```

### 3.2 Stage 1 — Roster source selection (RunModal)

The Run modal (`RunModal.tsx`, already exists for EC) extends with a two-radio picker:

- **Use existing onboarding roster** — pick from a list of xlsx files in `.tracker/rosters/` + `src/data/` (existing `/api/rosters` endpoint feeds this).
- **Download new from SharePoint** — fires `POST /api/sharepoint-download/run` with the configured `ONBOARDING_ROSTER` spec, waits for completion (existing fire-and-forget endpoint becomes synchronous-with-progress for this caller), then uses the freshly-downloaded file. Operator sees a small "downloading roster…" spinner inline.

Result: every prep batch carries an explicit `rosterPath` in the parent row's data. No "rosterMode" enum needed — both paths just produce a path.

This same modal is used for both EC and oath uploads. The workflow choice is implicit (whichever workflow's TopBar Run button opened the modal).

### 3.3 Stage 2 — OCR

Each PDF page is sent to an OCR provider with a workflow-specific prompt. Current `src/ocr/` already does multi-provider rotation (Gemini multi-key + 7-provider fallback) and per-file caching. **Two changes:**

**(a) Parallel page processing.** Today `runOcr` may be sending the whole PDF as one request. For per-page processing, we split the PDF and dispatch pages in parallel (Promise.all with a concurrency cap of 4-6 to respect rate limits). Order is preserved by collecting results into an indexed array. Cache keys become per-page (`{pdfHash}-page-NN`) so a page that fails one provider can be retried independently.

**(b) Prompt additions** (both workflows):
- "Classify each page as `expected` (matches a known form template for this workflow) or `unknown` (blank page, irrelevant document, scan artifact). Return `documentType` per record."
- "For each field that should appear on this form but is blank/unreadable on the paper, add the field name to `originallyMissing`. The match phase will populate values via the roster; the operator needs the list to know which fields to write on the physical paper."

**Provider strategy.** The user has many API keys; the OCR module already supports multi-provider rotation. Use the highest-quality vision model available per call (Gemini 2.5 Pro / Claude Opus 4.7 / GPT-5 vision — whichever is configured), with rotation on failure. No need to manually pick per task — the rotation already prefers higher-quality providers and falls back. Document this in `src/ocr/CLAUDE.md`.

### 3.4 Stage 3 — Match (algorithmic + LLM disambiguation)

Existing `matchAgainstRoster` in `src/match/` does Levenshtein-based name match; auto-accepts at score ≥ 0.85. Extension:

**Hybrid match:**
- Score ≥ 0.85 → accept algorithmically (existing behavior).
- 0.50 ≤ score < 0.85 → send top 5 candidates + the OCR'd name + any context (jobTitle, dept) to a text LLM call: "Given this person's OCR'd name 'Renée Coleman' and these roster candidates: [Coleman, Renee R | EID 10706431 | Dining], [Cohlman, Renee | EID 10812990 | Library], … — which is the same person? Return the EID, or `none` if uncertain." Use the same provider rotation infrastructure (prompts module).
- Score < 0.50 → leave unresolved; will go through eid-lookup in stage 4.

**Bidirectional verification.** When the paper provides BOTH a name and an EID, the match phase verifies they're consistent:
- Roster lookup by EID returns the canonical name; compare it to the OCR'd name (Levenshtein normalized).
- If both agree: `matchSource: "form"`, no warning.
- If EID is in roster but name doesn't match: warning `"name on paper (Renee Cohlman) does not match roster name for this EID (Renee Coleman)"`.
- If EID is NOT in roster: warning `"EID 10706431 not found in roster"`, fall back to name-only matching.

When the paper provides only a name OR only an EID, `originallyMissing` already records the gap.

### 3.5 Stage 4 — eid-lookup (existing, no change)

For records still without an EID after match: enqueue into the eid-lookup daemon (existing pattern; itemId prefix `ec-prep-` or `oath-prep-`). Eid-lookup resolves via Person Org Summary name search and writes results back into the parent row via the existing JSONL-watch pattern.

### 3.6 Stage 5 — Person Org Summary verification (NEW)

For every record with an EID, capture verification data (active status + HDH dept + screenshot). **Reuses the existing eid-lookup daemon** rather than spawning a dedicated UCPath browser at prep time. **Two paths to avoid duplicate work:**

**Path A — Records that came from stage 4 (eid-lookup name search):** verification data is already a side-effect of stage 4. The eid-lookup workflow already drills into Person Org Summary, captures `hrStatus` + `department`, and applies the HDH filter (a non-HDH result is rejected, never returned). The only missing piece is the screenshot — extend the existing eid-lookup handler to call `ctx.screenshot({ kind: "form", label: "person-org-summary" })` after drill-in. The prep watcher reads `hrStatus`, `department`, and the screenshot filename out of the existing result and writes them into the record's `verification` field. **No additional Person Org Summary lookup needed for these records.**

**Path B — Records that came from stage 3 (roster match) OR had a paper EID** that was verified against the roster but never went through stage 4: enqueue a verification-only item into the eid-lookup daemon with the new `{emplId}` input shape. The eid-lookup handler branches: `{name}` runs the existing search-by-name flow; `{emplId}` runs a new much-faster `searchByEid` (single navigation, drill-in, extract). Both capture the same screenshot. Prep watches for completion and patches `verification` into the record.

**Prep orchestrator coordination:** as soon as a record gets an EID (from stage 3 algorithmic match, paper EID, or stage 4 lookup), the orchestrator decides which verification path applies and enqueues if needed. Verification fans out in parallel with stage 4 — they share the eid-lookup daemon's shared-context-pool (4 workers), so a 24-record batch with mixed paths typically finishes verification in 1-3 minutes.

**The `verification` field is computed from the result:**
- `active = hrStatus === "Active"` (UCPath uses Active/Terminated/Leave/etc.)
- `hdh = isAcceptedDept(department)` (existing whitelist: housing/dining/hospitality keyword match)
- State enum: `verified` (active && hdh) / `inactive` (!active) / `non-hdh` (active && !hdh) / `lookup-failed` (search returned nothing or errored).

**What happens for records that fail verification?**
- `verification.state` ≠ `"verified"` → record is auto-deselected (`selected: false`) so it won't be approved by default.
- Screenshot is still captured + linked so the operator can see why.
- The operator CAN force-select (override) — surfaces a two-click confirmation toast (see §12.2).

**Note about path A's "non-HDH" handling.** The eid-lookup workflow today REJECTS non-HDH results during search-by-name (treats them as "no result" so the CRM-only branch fires). For prep-flow verification, we want to KEEP non-HDH results — the operator needs to see them flagged. Extension: the eid-lookup handler accepts a flag (set by the verify caller) that disables the HDH-rejection filter and returns the raw result with `department` populated, leaving the HDH judgment to the prep orchestrator. CLI invocations of eid-lookup keep the existing rejection behavior.

### 3.7 The "ready" prep row data

When all five stages complete, the parent tracker row holds:

```ts
data: {
  mode: "prepare",
  pdfPath: string,
  pdfOriginalName: string,
  rosterPath: string,
  pageImagesDir?: string,                    // .tracker/uploads/<parentRunId>/
  records: Array<PreviewRecord | OathPreviewRecord>,  // workflow-specific shape
  ocrProvider?: string,
  ocrAttempts?: number,
  ocrCached?: boolean,
}
```

Each record (regardless of workflow) carries:
- `sourcePage: number` — 1-indexed page in the PDF (preserved upload order).
- `documentType: "expected" | "unknown"` — anomaly flag.
- `originallyMissing: string[]` — fields blank on paper.
- `matchState: "extracted" | "matched" | "lookup-pending" | "lookup-running" | "resolved" | "unresolved"`.
- `matchSource?: "form" | "roster" | "eid-lookup"`, `matchConfidence?: number`, `rosterCandidates?: [...]`.
- `verification?: { state: "verified" | "inactive" | "non-hdh" | "lookup-failed", hrStatus?, department?, screenshotFilename?, error?, checkedAt }`.
- `selected: boolean`, `warnings: string[]`.
- Workflow-specific extension fields (EC: employee + emergencyContact; oath: printedName, signed, dateSigned, employerSigned).

---

## 4. The Review Pane (cross-workflow UI)

### 4.1 Prep row in the queue panel (bento shape)

Matches the standard `EntryItem` bento card so prep rows scan with the same visual rhythm as regular rows.

**Differentiators from a regular EntryItem:**
- Subtle 3-px accent bar on the left (color = state: primary preparing, warning ready, primary reviewing, destructive failed).
- The card body is clickable. Click opens the review pane (same selection treatment as a regular EntryItem: ring-2 ring-primary).

**Top zone (head):**
- Status icon (Loader2 spinning preparing, Clock ready, CheckCircle2 reviewing, AlertTriangle failed).
- Filename.
- Status badge (right): tracks the live stage. `Roster · loading` / `OCR · attempt 1` / `Match · 18/24` / `EID lookup · 4 pending` / `Verify · 14/24` / `Ready` / `Reviewing` / `Failed`.
- Optional second line under the head:
  - **Preparing**: 5-dot stage strip (Roster · OCR · Match · EID lookup · Verify) — dots progress green / primary-active / muted as the orchestrator advances.
  - **Ready**: summary `<strong>22</strong> verified · 1 needs review · 1 to remove`.
  - **Reviewing**: live counts `<strong>9</strong> selected · 1 unsaved edit`.
  - **Failed**: error message in destructive color.

**Foot zone:**
- Time · `prep#N` run pill · meta cell · `<spacer>` · count cell (`24 rec`) · ✕ discard · (Failed only) Retry.

**No Review button anywhere.** Click the card to open review.

### 4.2 Click-to-review interaction

| User action | Result |
|---|---|
| Click the prep row body (anywhere except foot action buttons) | Review pane opens, replaces LogPanel. Prep row gets `reviewing` state. Scroll position restores from localStorage. Only enabled for `Ready` and `Reviewing` states; `Preparing` and `Failed` rows aren't clickable for review. |
| Click foot action buttons (✕ discard, Retry) | `event.stopPropagation()` so the row click doesn't fire. Discard closes the review pane if it's open. |
| Click another queue entry while reviewing | Review closes; LogPanel returns. Scroll position is persisted. |
| Click Back / Cancel in review header | Same as clicking another entry. Edits remain in localStorage. |
| Click Approve N | Existing approve-batch flow fires. On success, prep row → `done` step `approved`, filtered out of panel. |

Re-entry silently restores scroll position via `{workflow}-prep-cursor:<runId>` in localStorage.

### 4.3 Paired-scroll layout

When the review pane opens, the right pane (LogPanel area) is fully replaced. TopBar / WorkflowRail / QueuePanel stay.

**Header (50 px):**
- Back arrow · file icon · filename · `Review` crumb pill.
- Sub-line: `12 records · 10 verified · 1 needs review · 1 to remove · ocr: gemini-2.5-pro`.
- Right side: master selection summary (`<ck> 9 of 10 selected`) · Cancel · Approve N.

**Body — paired-scroll list:**
- Records grouped by `sourcePage`, then per group:
  - **Group of 1 record on the page** → render as a paired pair: PDF page on the left + form card on the right.
  - **Group of 2+ records on the page** (oath sign-in sheets) → render as a "multi-pair": sticky PDF on the left (`position: sticky; top: 16px`) + stack of row-form cards on the right.
- Records appear in source-PDF order (sort by `sourcePage` ascending, then `rowIndex` for sign-in sheet rows).
- All form cards render at full opacity. No "active" highlight, no dimming.
- Vertical scroll exposes every record; no Prev/Next button.

### 4.4 Form card anatomy

**Header of each form card (top to bottom):**
- **Page-location chip** (prominent, monospace): `Page 7 of 12 in pile` for single-form pages, `Page 7, Row 3 of 8 in pile` for sign-in sheet rows. This is what the operator uses to find the physical paper.
- Record name (large, bold).
- Right side: **state badges** stacked vertically (4 possible badges):
  - Match-state badge (`matched` / `resolved` / `unresolved`) + match source/confidence (`roster · 100%`).
  - Verification badge (`✓ HDH active` green / `⚠ inactive` red / `⚠ non-HDH` red / `verify failed` muted) — links to the captured screenshot via the existing `/screenshots/<filename>` endpoint.
  - Document-type badge (only when `documentType: "unknown"` — destructive `⚠ unknown document`).
  - Signature badge (oath only — `⚠ employee unsigned` / `⚠ officer unsigned` when applicable).

**Below the header — banner stack** (any combination, in this order):
- **`⚠ REMOVE FROM PILE — page N` banner** when `documentType === "unknown"`. Destructive-tinted. Selected checkbox is forced off and disabled.
- **`⚠ Add to paper: <fields>` banner** when `originallyMissing.length > 0`. Amber-tinted, lists field names.
- **`⚠ Verification: <reason>` banner** when verification state is not `verified`. Includes a "View Person Org Summary screenshot" link.
- **`⚠ Signature: <reason>` banner** (oath only) when employee or officer signature is missing.

**Form fields below banners** — workflow-specific. Each field whose name is in `originallyMissing` gets a small amber pencil icon next to its label with tooltip "Was blank on paper — please add to physical form".

**At the bottom of every form card:**
- The `Selected` checkbox (with "in batch" / "excluded" label). Same data as the master selection — toggling either updates the other. Disabled when verification fails or document is unknown (operator can override by clicking again to force-select; surfaces a small confirmation tooltip).

### 4.5 Multi-pair (sign-in sheet) variant

For oath sign-in sheets, the page contains many records. The PDF preview stays sticky on the left while the operator scrolls through the row-form stack on the right. The active row's form (the one most-visible in the viewport) is NOT visually highlighted — keeping with the "no active highlight" rule. The operator just scrolls through forms; the sticky PDF gives visual context.

The PDF image itself does NOT get per-row highlights overlaid (would require image annotation work for marginal benefit). The page-location chip on each form card already says `Page 7, Row 3 of 8 in pile` — the operator uses that to count down to the right row on the physical paper.

---

## 5. Per-workflow specifics

### 5.1 Emergency Contact — trimmed field set

The OCR'd EC schema today captures the entire UCSD R&R Emergency Contact form (employee section + emergency contact section). For the review pane, **trim to only what the EC workflow actually fills into UCPath, plus identity for matching**:

**Editable fields in the EC review form:**
- Empl ID (identity)
- Lived Employee Name (identity, for paper match)
- Contact Name
- Relationship (raw text → mapped via `RELATIONSHIP_MAP` at workflow runtime)
- Same-as-employee toggle
- Contact Address: street / city / state / zip (only shown when same-as-employee is unchecked)
- Cell Phone
- Home Phone
- Work Phone

**Dropped from the review form** (still extracted by OCR for context, but NOT shown):
- PID, Job Title, Work Location, Mail Code, Supervisor.
- Work Email, Personal Email.
- Home Address (employee section), Home Phone (employee), Cell Phone (employee).

These are extracted and persisted in the data layer because they're useful for diagnostics, but the review form doesn't show them — the operator only edits what UCPath will actually write.

### 5.2 Oath Signature — three formats + signature presence checks

**Three paper formats supported:**
- **Sign-in sheet** — multi-row table (N records per page) → renders via the multi-pair layout.
- **UPAY585** (1997, with Patent Acknowledgment) — single-form per page.
- **UPAY586** (2015, DocuSign, oath only) — single-form per page.

`OathPreviewRecord.rowIndex` stays in the schema (used by sign-in sheet rows). Single-form pages get `rowIndex: 0`.

**Signature presence checks** (new):
- OCR prompt extracts two signature flags per record:
  - `employeeSigned: boolean` — is the employee/officer signature line filled?
  - `officerSigned: boolean` — is the authorized-official / witness signature filled? (Sign-in sheets typically have only the employee signature; in that case `officerSigned` is `null` not `false` so we don't false-flag.)
- Records with `employeeSigned === false` or `officerSigned === false` get `selected: false` and a banner `⚠ Signature missing — employee did not sign` (or officer).
- The operator can override (force-select), e.g., if they collected the missing signature offline.

**Editable fields in the oath review form:**
- Empl ID
- Printed Name
- Date Signed
- Employee Signed? (Yes/No)
- Officer Signed? (Yes/No/N/A) — N/A for sign-in sheets where this isn't applicable.

### 5.3 Digital-mode oath — bypasses review entirely

Today digital mode (EID-paste flow) writes a `mode: "prepare"` parent row and goes through `OathPreviewRow`. **Change: digital mode skips the prep/review pattern entirely.**

- For each pasted EID: lookup oath date in CRM onboarding-history (existing logic).
- Enqueue `{emplId, date: foundDate ?? undefined}` directly via `enqueueFromHttp` / `ensureDaemonsAndEnqueue`.
- EIDs with no CRM date still get enqueued (UCPath today-prefills when `date` is undefined).
- No prep row, no review — child kernel rows show up in the queue immediately.

`TopBarDigitalOathButton.tsx` (currently deleted in working tree) gets reinstated, pointing at the simplified flow. The existing CRM browser launch + Duo still happens (the lookup needs an authenticated CRM session); only the surface changes.

---

## 6. Backend changes

### 6.1 New: `src/ocr/render-pages.ts`

`renderPdfPagesToPngs(pdfPath: string, outDir: string): Promise<string[]>`. Renders each page to PNG using a pure-JS PDF library (no system dep — `pdftoppm` isn't on the dev machine). Candidates: `pdfjs-dist` + canvas, or `pdf-to-img`. Pick at implementation time; document in `src/ocr/CLAUDE.md`. Returns an array of page filenames (1-indexed: `page-01.png`, `page-02.png`, …).

If rendering fails for any reason, the function logs a warning and returns an empty array. Prep continues; review pane shows a placeholder for missing previews. Don't fail prep on a preview-only feature.

### 6.2 New: `src/ocr/disambiguate.ts`

`disambiguateMatch(query: string, candidates: RosterCandidate[]): Promise<{eid?: string; confidence: number}>`. Sends a small text-only prompt to the rotation pipeline (any provider, no images), asking the LLM to pick the best candidate or return `none`. Cheap call (small prompt, short response). Used in stage 3 of the OCR + Roster Method when algorithmic confidence is in the 0.50–0.85 band.

### 6.3 Extension: `src/workflows/eid-lookup/`

**Schema extension** (`schema.ts`):
- `EidLookupItemSchema` becomes `z.union([{ name: z.string() }, { emplId: z.string() }])`.
- Existing handler reads `"name" in input` to branch.

**New search-by-EID** (`search.ts`):
- `searchByEid(page, emplId): Promise<EidResult>` — direct navigation, fills Empl ID textbox, clicks Search, drills into single-result row, extracts the same `EidResult` shape.

**Handler extension** (`workflow.ts`):
- `searchingStep` branches: `name` input → existing `searchByName`; `emplId` input → new `searchByEid`.
- After both branches, capture screenshot via `ctx.screenshot({kind: "form", label: "person-org-summary"})`. The captured filename is added to the tracker row's data so the prep watcher can read it.
- `crossVerificationStep` (CRM check) is skipped for EID-input items (no CRM cross-check needed for verification-only items).

**Item-id derivation** for verification items: `oath-verify-<parentRunId>-r<index>` / `ec-verify-<parentRunId>-r<index>`. Distinct from the eid-lookup `oath-prep-` / `ec-prep-` prefixes used for unresolved-name lookups, so the prep watcher can distinguish.

### 6.4 Extension: prep orchestrators

`runPrepare` (`src/workflows/emergency-contact/prepare.ts`) and `runPaperOathPrepare` (`src/workflows/oath-signature/prepare.ts`):

- After OCR (stage 2): persist page PNGs via `renderPdfPagesToPngs`. Write `pageImagesDir` into the parent row's data.
- During match (stage 3): wire `disambiguateMatch` into the borderline-confidence branch.
- After eid-lookup (stage 4) — for every record with an EID: enqueue a verification item into the eid-lookup queue (`{emplId}` shape, `*-verify-` itemId prefix).
- Watch the eid-lookup JSONL for verification completions (extension of the existing watch loop). For each result, compute `verification.state` and patch into the record.
- Mark prep row `done` when all stages complete (or all verification items finish).

### 6.5 New endpoint: `GET /api/prep/pdf-page`

Query: `?workflow=emergency-contact|oath-signature&parentRunId=...&page=N`. Streams `.tracker/uploads/<parentRunId>/page-NN.png` with path-traversal guard (mirrors `/screenshots/<filename>`). 404 if the file doesn't exist. Single endpoint serves both workflows.

### 6.6 RunModal extension: roster picker

Add a "Download new from SharePoint" radio option to the roster picker. Selecting it:
1. Fires `POST /api/sharepoint-download/run` with the `ONBOARDING_ROSTER` spec.
2. Polls `/api/sharepoint-download/status` (NEW endpoint — small wrapper that reads the in-flight lock + last completion time) until done.
3. Re-fetches `/api/rosters` and selects the freshly-downloaded file.
4. Then proceeds with the normal upload submit.

Inline progress text in the modal: "Downloading roster from SharePoint…".

### 6.7 Cleanup hooks

- On approve-batch success → `rm -rf .tracker/uploads/<parentRunId>/`.
- On discard-prepare → same.
- On dashboard startup → sweep `.tracker/uploads/*/` for parentRunIds not present in any tracker JSONL. Extends `cleanTrackerMain`.

### 6.8 What doesn't change

- Backend approve / discard endpoints (`/api/{ec,oath}-signature/approve-batch`, `/discard-prepare`) — same shapes.
- The kernel workflows (`emergencyContactWorkflow`, `oathSignatureWorkflow`) — no changes.
- The eid-lookup workflow's existing `{name}` branch — no changes; only the new `{emplId}` branch is added.
- Dashboard QueuePanel splitting logic (`isPrepareRow` filter) — same.

---

## 7. Component map (frontend)

### 7.1 What gets unified vs. kept per-workflow

The prep-row visual shape and the review pane shell are 100% identical across workflows — only data shapes (form fields, match-state vocabulary) differ. **Unify the components, parameterize the workflow-specific bits.** Schemas stay separate.

**Deleted:**
- `OathPreviewRow.tsx` — folded into the unified `PreviewRow.tsx`.
- `PreviewRecordRow.tsx` — record list no longer lives inside the prep row.
- `PreviewRecordEditForm.tsx` — same; edit lives in the new review pane.
- The inline `OathRecordRow` inside `OathPreviewRow.tsx` — same.

**Modified:**
- `PreviewRow.tsx` — rewritten to the unified bento shape. Branches on `entry.workflow` only for: discard-endpoint URL, summary-line vocabulary.
- `QueuePanel.tsx` — drop the per-workflow branch (lines 92-96). All prep rows render via the unified `PreviewRow`.
- `App.tsx` — new state `reviewingPrepId: string | null`. Right pane swaps between `<LogPanel>` and `<PrepReviewPane>`.
- `RunModal.tsx` — adds the "Download new from SharePoint" roster option + progress display.

**New (cross-workflow):**
- `PrepReviewPane.tsx` — the LogPanel replacement. Owns the header, scroll body, per-pair list. Branches on `entry.workflow` for: approve-endpoint URL, approvable-state rules, which form-fields component to render. Also computes the page grouping (single vs multi-pair).
- `PrepReviewPair.tsx` — one PDF page on the left, one form card on the right.
- `PrepReviewMultiPair.tsx` — sticky PDF on the left, stack of form cards on the right (oath sign-in sheet variant).
- `PrepReviewFormCard.tsx` — the form-card chrome (page-location chip, name, badge stack, banner stack, form fields container, selected-checkbox footer). Workflow-specific form fields are passed in as a child component.
- `PdfPagePreview.tsx` — `<img>` with skeleton + 404 fallback. Lazy via native `loading="lazy"`.

**New (workflow-specific):**
- `EcReviewForm.tsx` — EC trimmed field set: Empl ID, Name, Contact Name, Relationship, Same-as-employee toggle, Contact Address, Cell/Home/Work Phone.
- `OathReviewForm.tsx` — Oath field set: Empl ID, Printed Name, Date Signed, Employee Signed?, Officer Signed?

**Type strategy:**
- No generic `PrepRecord<T>` envelope. The two record types stay separate. `PrepReviewPair` is generic over `<R extends BasePrepRecord>` where `BasePrepRecord` captures the cross-workflow fields (`sourcePage`, `selected`, `matchState`, `warnings`, `documentType`, `originallyMissing`, `verification`).
- `PreviewRow` accepts the union via `TrackerEntry` (already untyped on `data`); internally calls workflow-specific parsers.

### 7.2 What we don't unify (and why)

- **Backend HTTP handlers** (`emergency-contact-http.ts`, `oath-signature-http.ts`) — duplicated, but each is workflow-specific Zod-schema wrapping. Two consumers today; per the project rule "promote when there are three" — defer.
- **Backend prepare orchestrators** (`prepare.ts` files) — same reasoning. Each owns workflow-specific OCR prompt schemas + match logic.
- **Preview-record schemas** — different domain models. Adding shared base fields (documentType, originallyMissing, verification) is additive, not a forced merge.

---

## 8. State persistence

| Key | Owner | Lifetime |
|---|---|---|
| `ec-prep-edits:<runId>` | existing | Cleared on Approve / Discard |
| `oath-prep-edits:<runId>` | existing | Cleared on Approve / Discard |
| `ec-prep-cursor:<runId>` | **new** | Cleared on Approve / Discard |
| `oath-prep-cursor:<runId>` | **new** | Cleared on Approve / Discard |

Cursor = integer index of the topmost-visible pair (computed via `IntersectionObserver` debounced to 250 ms). On re-entry, scroll to that pair.

---

## 9. Schema changes (consolidated)

**Both `PreviewRecordSchema` (EC) and `OathPreviewRecordSchema`** gain:
- `documentType: z.enum(["expected", "unknown"]).default("expected")` — additive.
- `originallyMissing: z.array(z.string()).default([])` — additive.
- `verification: z.discriminatedUnion("state", [
   z.object({ state: z.literal("verified"), hrStatus: z.string(), department: z.string(), screenshotFilename: z.string(), checkedAt: z.string() }),
   z.object({ state: z.literal("inactive"), hrStatus: z.string(), department: z.string().optional(), screenshotFilename: z.string(), checkedAt: z.string() }),
   z.object({ state: z.literal("non-hdh"), hrStatus: z.string(), department: z.string(), screenshotFilename: z.string(), checkedAt: z.string() }),
   z.object({ state: z.literal("lookup-failed"), error: z.string(), checkedAt: z.string() }),
 ]).optional()` — populated by stage 5.

**`OathRosterOcrRecordSchema`** gains:
- `employeeSigned: z.boolean()` — replaces the existing `signed` (semantic rename + clarification).
- `officerSigned: z.boolean().nullable().optional()` — `null` for sign-in sheets.
- Old `signed` field removed (was ambiguous between the two signatures).

**Both `PrepareRowDataSchema` and `OathPrepareRowDataSchema`** gain:
- `pageImagesDir: z.string().optional()` — relative path under `.tracker/`. Optional so old prep rows fall back gracefully.

**`EidLookupItemSchema`** changes:
- From `z.object({ name: z.string() })` to `z.union([z.object({ name: z.string() }), z.object({ emplId: z.string() })])`.

---

## 10. Out of scope

- Launch surfaces (TopBar Run / Capture buttons themselves) — already shipped, reused.
- The kernel per-record workflows (the actual UCPath transactions) — no changes.
- Daemon mode itself — no changes.
- Promoting backend HTTP handlers to a shared factory — defer to "when a third consumer lands."
- Non-OCR-driven workflows (separations, work-study, etc.) — out of scope; this spec only touches the OCR + Roster Method consumers.
- Annotating per-row highlights inside the sign-in sheet PDF preview — page-location chip is enough.

---

## 11. Implementation phases

Ordered so the dashboard stays usable throughout. Each phase ships something operator-visible (or strictly additive).

### Phase 1 — Backend + schema (additive, old UI keeps working)

- New `src/ocr/render-pages.ts` (PDF page rendering).
- New `src/ocr/disambiguate.ts` (LLM disambiguation helper).
- Per-page OCR + parallel processing in `src/ocr/index.ts`.
- OCR prompt updates (both workflows): documentType + originallyMissing + signature flags.
- Schema additions: `documentType`, `originallyMissing`, `verification`, `pageImagesDir`, `employeeSigned`/`officerSigned`.
- `EidLookupItemSchema` union; `searchByEid` in `search.ts`; eid-lookup handler branch + screenshot capture.
- Prep orchestrator extensions: page rendering, disambiguation wiring, verification fan-out + JSONL watch.
- New endpoint `GET /api/prep/pdf-page`.
- New endpoint `GET /api/sharepoint-download/status`.
- Cleanup hooks (approve / discard / startup sweep).
- Old inline-expand UI keeps working — Phase 1 is purely additive at the data + endpoint layer.

### Phase 2 — Atomic UI swap

- New `PrepReviewPane.tsx` + `PrepReviewPair.tsx` + `PrepReviewMultiPair.tsx` + `PrepReviewFormCard.tsx` + `PdfPagePreview.tsx`.
- New `EcReviewForm.tsx` + `OathReviewForm.tsx`.
- Rewrite `PreviewRow.tsx` to unified bento shape with click-to-review.
- Delete `OathPreviewRow.tsx`, `PreviewRecordRow.tsx`, `PreviewRecordEditForm.tsx`.
- `App.tsx` adds `reviewingPrepId` state + swaps right pane.
- `QueuePanel.tsx` drops the per-workflow PreviewRow branch.
- Cursor persistence (IntersectionObserver + localStorage).
- Render-branch dispatcher: group by `sourcePage`, dispatch single/multi.
- Trim EC review form to the §5.1 field set.
- Atomic so the operator never sees a half-built state.

### Phase 3 — RunModal roster picker enhancement

- `RunModal.tsx` adds the "Download new from SharePoint" radio option.
- New `useSharePointDownload` hook polls `/api/sharepoint-download/status` until complete.
- Wire to both EC and oath upload entry points.

### Phase 4 — Digital-mode bypass

- Rewrite `runDigitalOathPrepare` to skip prep-row + review entirely; enqueue `{emplId, date?}` directly per EID.
- Reinstate `TopBarDigitalOathButton.tsx` pointing at the simplified flow.
- Drop digital `mode: "prepare"` writes; `OathPreviewRow` no longer needs to handle them.
- Document the new behavior in `oath-signature/CLAUDE.md`.

---

## 12. Open questions

1. **Verification screenshot location** — prep flow currently has its own `.tracker/uploads/<parentRunId>/` directory. Verification screenshots come from the eid-lookup daemon and land in `.screenshots/`. Decision: **keep them in `.screenshots/`** (existing serving endpoint, no new plumbing). Record the screenshot filename in `verification.screenshotFilename`.
2. **Force-select override UX** — when a record is auto-deselected due to verification failure or unknown document, clicking the checkbox once should pop a small confirmation toast: "Approve anyway? This record failed verification (inactive employee). Click again to confirm." Two-click confirmation prevents accidental approval of bad records.
3. **Concurrency cap for parallel OCR** — start at 4-6; tune based on observed rate-limit errors. Cap is configurable via env var `OCR_PAGE_CONCURRENCY` for fast iteration.

---

## 13. References

- Existing prep row components: `src/dashboard/components/{PreviewRow,OathPreviewRow,PreviewRecordRow,PreviewRecordEditForm}.tsx`.
- Existing prep schemas: `src/workflows/{emergency-contact,oath-signature}/preview-schema.ts`.
- Existing prep orchestrators: `src/workflows/{emergency-contact,oath-signature}/{prepare,digital-prepare}.ts`.
- Existing approve / discard handlers: `src/tracker/{emergency-contact-http,oath-signature-http}.ts`.
- eid-lookup workflow (extended): `src/workflows/eid-lookup/{schema,search,workflow}.ts`.
- HDH dept whitelist: `isAcceptedDept` in `src/workflows/eid-lookup/search.ts`.
- Person Org Summary selectors: `src/systems/ucpath/selectors.ts` (`personOrgSummary` namespace).
- Bento card reference: `src/dashboard/components/EntryItem.tsx`.
- Visual mockups (gitignored): `.superpowers/brainstorm/36717-1777508229/content/dashboard-v6-prep-row-no-review.html`, `dashboard-v5-uniform.html`.
