# OnBase Workflow

Imports HR documents into **OnBase** (Hyland), one document per person. First
document type wired: **Emergency Contact** (`X_HR_Emergency Contact`).

**Per-person fan-out target.** Like emergency-contact / oath-signature, OnBase
is NOT operator-started directly. The operator uploads PDF(s) through the OnBase
**run modal** → `/api/ocr/prepare?formType=onbase-emergency-contact&targetWorkflow=onbase`,
which stamps an **operation coordinator** row in the OnBase panel and delegates
an OCR prep under it. On approve, OCR fans out **one `operation-member` row per
person** to this workflow (one `OnbaseInput` each). So `onbase` lives in `WORKFLOW_LOADERS` and IS in the dashboard **upload** run-surface list (`DASHBOARD_UPLOAD_RUN_WORKFLOWS`) with a `run-modal-registry` entry — the operator uploads PDF(s) through the OnBase run modal (no typed input-run start). Like emergency-contact and oath-signature, the upload run creates the operation coordinator row and delegates OCR under it; the OCR approve fan-out is the only path that enqueues executable onbase rows.

`archetype: "batch"`, `inputSubject: "eid"`, `code: "ob"`. Drives the
**onbase** system (`src/systems/onbase/`).

## One person = one page

The operator may upload many PDFs; they are merged into one combined PDF (each
page = one person) before OCR. Each fanned `OnbaseInput` carries `pdfFileId`
(the combined PDF) + `sourcePage`; the handler resolves the file and splits that
one page out (`extractPdfPage`, `src/services/ocr/pdf-pages.ts`) to feed OnBase's
file picker — no temp file (uploads the bytes directly).

## What OCR actually needs to extract

The OnBase **Employee Lookup keyset autofills every keyword** (names, department,
vice chancellor, titles, dates) once you run its **modal** (key-icon → fill
UCPath ID → Find → Select Employee — NOT typing the UCPath ID + Tab, which does
nothing; see `src/systems/onbase/LESSONS.md` 2026-07-02). The ONLY required field
it leaves blank is **Document Name** (constant `EMERGENCY CONTACT INFORMATION`).
So OCR's real job is to read the **UCPath ID** per page; the `*` fallback fields
on `OnbaseInput` (names, dept, VC) are used ONLY when the keyset returns nothing
(bad/unknown ID) — but note Department/VC come ONLY from the keyset, so a keyset
miss is unrecoverable, not fallback-fillable. See `src/systems/onbase/CLAUDE.md`.

## Handler steps

1. `authenticate` — deferred `loginToOnBase` (idempotent; daemon Duos once;
   self-heals a stale single-session slot via the Logout.aspx hop — see
   `src/systems/onbase/LESSONS.md` 2026-07-02).
2. `prepare-import` — open Import Document (clears any leftover Document-Queue
   rows — duplicate-import defense); select doc type + File Type `PDF (.pdf)` +
   `Employee Lookup` keyset; split + attach this person's page (confirmed via
   the Document Queue "Pending Import" row, not fire-and-forget).
3. `fill-keywords` — run the Employee Lookup keyset **modal**
   (`lookupEmployeeViaKeyset`: key-icon → dialog → fill UCPath ID → Find →
   Select Employee, which autofills every keyword; NOT Tab-autofill — see
   `src/systems/onbase/LESSONS.md` 2026-07-02). Tri-state semantics: `selected`
   → proceed; `no-match` (a DATA problem) → fill what fallback can supply, then
   **fail loud** on anything still blank (Department/Vice-Chancellor come only
   from the keyset); a STALLED postback **throws** (kernel-retryable) — a slow
   cluster is never mislabeled "person not found". Then set Document Name.
4. `import` — `waitForImportEnabled` (enablement commits via an async postback;
   a single sample can read a transient disabled state). Dry-run screenshots,
   asserts the form was importable, and skips the click; otherwise click Import
   and assert the post-import landing is not an error page.

## Selector intelligence

This workflow touches: **onbase**. Before mapping a new selector run
`npm run selector:search "<intent>"`.

- [`src/systems/onbase/SELECTORS.md`](../../systems/onbase/SELECTORS.md)
- [`src/systems/onbase/LESSONS.md`](../../systems/onbase/LESSONS.md)
- [`src/systems/onbase/common-intents.txt`](../../systems/onbase/common-intents.txt)

## Dry run

`OnbaseInput.dryRun` walks the whole form (including the keyset autofill +
keyword verification) but screenshots and **skips the Import click** — never
commits a document.

## Lessons Learned

- **2026-06-22: Built as an OCR operation-member fan-out target (not born-at-upload).**
  OnBase per-person imports are independent browser work with independent
  success/failure, so they are fanned out as executable `operation-member` rows
  (the emergency-contact model), not a single born-at-upload task (the
  oath-upload model, which files ONE ticket for the whole PDF). The operation
  coordinator row is display-only; these member rows do the real OnBase imports.
- **2026-07-02: The keyset does the heavy lifting — but it's a MODAL, not Tab-autofill (corrects the 2026-06-22 claim).**
  Running the Employee Lookup modal (key-icon → fill UCPath ID → Find → Select
  Employee) autofills names, department + code, vice chancellor + code, titles,
  hire dates, status. Only Document Name is left to set. Treat OCR-extracted
  names/dept/VC as fallback only — but a keyset miss (no OnBase match) is
  terminal, since Dept/VC come ONLY from the keyset. **Typing the UCPath ID + Tab
  does nothing** (the old `enterUcpathIdAndTab` was wrong; now
  `lookupEmployeeViaKeyset`). See `src/systems/onbase/LESSONS.md` (2026-07-02).
