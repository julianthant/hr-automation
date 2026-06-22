# OnBase Workflow

Imports HR documents into **OnBase** (Hyland), one document per person. First
document type wired: **Emergency Contact** (`X_HR_Emergency Contact`).

**Per-person fan-out target.** Like emergency-contact / oath-signature, OnBase
is NOT operator-started directly. The operator uploads PDF(s) through the OnBase
**run modal** → `/api/ocr/prepare?formType=onbase-emergency-contact&targetWorkflow=onbase`,
which stamps an **operation coordinator** row in the OnBase panel and delegates
an OCR prep under it. On approve, OCR fans out **one `operation-member` row per
person** to this workflow (one `OnbaseInput` each). So `onbase` lives in
`WORKFLOW_LOADERS` but is **not** in the dashboard input/upload run-surface lists
as a typed start — its only entry is the OCR approve fan-out.

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
vice chancellor, titles, dates) the instant you type the **UCPath ID** and Tab.
The ONLY required field it leaves blank is **Document Name** (constant
`EMERGENCY CONTACT INFORMATION`). So OCR's real job is to read the **UCPath ID**
per page; the `*` fallback fields on `OnbaseInput` (names, dept, VC) are used
ONLY when the keyset returns nothing (bad/unknown ID). Department/VC normally
come straight from the keyset, NOT from OCR — see
`src/systems/onbase/CLAUDE.md`.

## Handler steps

1. `authenticate` — deferred `loginToOnBase` (idempotent; daemon Duos once).
2. `prepare-import` — open Import Document; select doc type + File Type
   `PDF (.pdf)` + `Employee Lookup` keyset; split + attach this person's page.
3. `fill-keywords` — type UCPath ID + Tab (`enterUcpathIdAndTab` returns whether
   the keyset autofilled); set Document Name; if the keyset was empty, fill the
   required keywords from fallback data; then **fail loud** if any required
   ("red") keyword is still blank.
4. `import` — dry-run screenshots and skips; otherwise verify the Import button
   is enabled and click it.

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
- **2026-06-22: The keyset does the heavy lifting — OCR only needs the UCPath ID.**
  Verified live: typing the UCPath ID + Tab autofills names, department + code,
  vice chancellor (`VCCFO`) + code, titles, hire dates, status. Only Document
  Name is left to set. Treat OCR-extracted names/dept/VC as fallback only.
