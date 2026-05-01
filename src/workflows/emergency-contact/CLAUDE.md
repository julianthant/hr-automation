# Emergency Contact Workflow

Fills the Emergency Contact form in UCPath HR Tasks → Personal Data Related for every record in a batch YAML. Fully autonomous after verification: you verify the YAML once (pre-extracted by Claude reading the handwritten PDF), then the workflow runs unattended for all records.

**Kernel-based.** Declared via `defineWorkflow` in `workflow.ts` and executed through `src/core/runWorkflowBatch` (sequential mode, `preEmitPending: true`, `betweenItems: ["reset-browsers"]`). The kernel owns browser launch, UCPath auth, per-record tracker entries, SIGINT cleanup. The CLI adapter `runEmergencyContact` owns pre-kernel phases: YAML load, optional SharePoint roster download + verify. **Add-New contact flow (when the target employee has zero existing emergency contacts) is NOT YET IMPLEMENTED** — `navigateToEmergencyContact` throws `NoExistingContactError`, the kernel records the record as `failed`, batch continues.

## Selector intelligence

This workflow touches one system: **ucpath** (HR Tasks → Personal Data Related → Emergency Contact).

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"emergency contact"`, `"hr tasks navigation"`, `"relationship dropdown"`).
- Per-system lessons (read before re-mapping): [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
- Per-system catalog (auto-generated): [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)

## Files

- `schema.ts` — Zod schemas + YAML loader (`loadBatch`). Top-level `BatchSchema = { pdfPath, batchName, records[] }`; each record validates against `RecordSchema` (the kernel's `TData` for this workflow).
- `config.ts` — `RELATIONSHIP_MAP` (raw handwritten text → UCPath dropdown value), `HR_TASKS_URL`, `TRACKER_DIR`, `ROSTERS_DIR`.
- `enter.ts` — `buildEmergencyContactPlan(record, page, ctx)` returns an `ActionPlan`: Add → Fill name → Check Primary → Select Relationship → Same-Address toggle (fill manual address if not same) → Fill phone → Save. `findExistingContactDuplicate(page, name)` reads existing contacts and returns the duplicate's display name if any.
- `roster-verify.ts` — Loads an xlsx/csv roster and verifies each batch record's EID + name exists. Co-located with its only consumer (moved from `src/utils/`).
- Roster + name/address matching primitives live in [`src/match/`](../../match/) — `findLatestRoster`, `loadRoster`, `matchAgainstRoster`, `compareUsAddresses`, `levenshteinDistance`. Shared with `oath-signature/prepare.ts` (moved out of this directory 2026-04-28 once the second consumer landed).
- SharePoint download lives in its own sibling workflow: [`src/workflows/sharepoint-download/`](../sharepoint-download/). Use `import { downloadSharePointFile } from "../sharepoint-download/index.js"`. (Moved out of this directory 2026-04-22 once the dashboard roster-download button made it cross-cutting.)
- `workflow.ts` — Kernel definition (`emergencyContactWorkflow`) + CLI adapter (`runEmergencyContact`).
- `fixtures/test-batch.yaml` — Minimal 2-record fixture with fake EIDs for dry-run smoke testing.
- `index.ts` — Barrel exports.

No `tracker.ts` — dashboard JSONL only (see `src/workflows/CLAUDE.md`).

## Kernel Config

| Field | Value |
|-------|-------|
| `systems` | `[{ id: "ucpath", login: loginToUCPath-wrapped }]` |
| `steps` | `["navigation", "fill-form", "save"] as const` |
| `schema` | `RecordSchema` — each batch record is a kernel TData |
| `authChain` | `"sequential"` |
| `tiling` | `"single"` |
| `batch` | `{ mode: "sequential", preEmitPending: true, betweenItems: ["reset-browsers"] }` |
| `detailFields` | `[]` — rich fields populated via `onPreEmitPending` + `updateData` |

## Data Flow

```
CLI: npm run emergency-contact <batchYaml>
  → runEmergencyContact (CLI adapter)
    → loadBatch (Zod validate whole file)
    → runPreflight: optional SharePoint download + verify EIDs/names
    → runWorkflowBatch(emergencyContactWorkflow, batch.records, {
          onPreEmitPending: (record, runId) => trackEvent(pending, data)
        })
        → Kernel Session.launch: 1 browser, UCPath auth (Duo ×1)
        → For each record (sequential):
          - Emit pending row via onPreEmitPending (with runId)
          - withTrackedWorkflow wraps the handler, reuses same runId
          - Handler step "navigation" → navigateToEmergencyContact(emplId)
            + extractEmployeeName + updateData({ employeeName })
            + findExistingContactDuplicate → updateData({ skipped }) + early return
          - Handler step "fill-form" → buildEmergencyContactPlan.execute
          - Handler step "save" → success log (plan's own save click wraps inside fill-form)
          - Between items: session.reset("ucpath")
      → Batch result summary: "N/M succeeded, K failed"
```

## Item ID shape

`p{NN}-{emplId}` — zero-padded source page + EID. Stable across re-runs with the same batch YAML; tolerates EID collisions across pages.

## Batch YAML layout

Lives under `.tracker/emergency-contact/` (gitignored — contains PII). Each record:

```yaml
- sourcePage: 1
  employee:
    name: ...
    employeeId: "10877384"   # numeric, ≥5 digits — workflow's primary key to UCPath
    ...
  emergencyContact:
    name: ...
    relationship: Mom         # raw; mapped to UCPath dropdown via RELATIONSHIP_MAP
    primary: true             # always true (1 contact per form)
    sameAddressAsEmployee: true
    address: null             # only present when sameAddressAsEmployee=false
    cellPhone: "(415) 377-2226"
    homePhone: null
    workPhone: null
  notes: []                    # extraction uncertainty flags (unused by code — for user eyeballing)
```

## Dashboard roster download

Lives in the sibling [`sharepoint-download/`](../sharepoint-download/) workflow — see its CLAUDE.md for the full story. TL;DR: the Download dropdown in every queue-panel header fires `POST /api/sharepoint-download/run` (backed by `buildSharePointRosterDownloadHandler`), which reads `ONBOARDING_ROSTER_URL` from env and saves the xlsx to `src/data/`. As of 2026-04-22 sharepoint-download IS a kernel workflow (appears in the TopBar dropdown as "SharePoint Download") so operators can see per-run logs + queue rows + session-panel progress. The HTTP endpoint is fire-and-forget (202) — progress is observed in the Sessions panel, not via the response body.

## Pre-flight roster verification

Optional but recommended. `--roster-url` downloads the latest roster from SharePoint (via `downloadSharePointFile` in `src/workflows/sharepoint-download/` — handles SSO + Duo); `--roster-path` uses a local xlsx you already have. Uses `verifyBatchAgainstRoster` in `src/workflows/emergency-contact/roster-verify.ts`:

- Finds `Employee ID` column and `Name` column (or `First Name` + `Last Name`) in row 1 headers
- For each batch record: checks EID exists + name words intersect (case-insensitive, tolerates "Doe, Jane" vs "Jane Doe")
- Aborts on mismatches unless `--ignore-roster-mismatch`

## Dashboard integration

- Workflow name: `emergency-contact`
- Steps (in order): `navigation` → `fill-form` → `save`
- Detail fields (declared via `defineWorkflow({ detailFields })` → dashboard registry): Employee, Empl ID, Contact, Relationship
- `onPreEmitPending` data keys: `batchName, sourcePage, emplId, employeeName, contactName, relationship`
- Handler `updateData` extensions: `skipped` + `skipReason` for duplicate-guard early return

## Gotchas

- **Add-New path not yet implemented**: When a target employee has no existing emergency contact on file, `navigateToEmergencyContact` throws `NoExistingContactError`. The kernel's `withTrackedWorkflow` wrapping records the record as `failed` and the batch continues to the next record. A different UCPath navigation path is needed for the Add case (probably NavBar → Workforce Administration → Personal Information → Biographical → Personal Data). A separate future plan covers this.
- **`#pt_modalMask` intercepts clicks** — must hide via `hidePeopleSoftModalMask(page)` before every click. Already done for Search / Add-new-row / Edit Address / OK / Save in `enter.ts`.
- **Per-record error handling**: one record failing does not abort the batch. `runWorkflowBatch` wraps each record in its own `withTrackedWorkflow` — errors land as `failed` tracker entries; the loop moves on. The final summary line reports `N/M succeeded, K failed` and prints up to 3 error messages.
- **Auth once, use many**: UCPath auth runs once via the kernel's `Session.launch` at the top of the batch; the same browser page is reused for all records. Between records the kernel calls `session.reset("ucpath")` (no-op here since UCPath's system config has no `resetUrl`, and `navigateToEmergencyContact` performs an absolute navigation anyway).
- **Address "same as employee" is computed during extraction** — not on the paper form. YAML has the boolean already.
- **Phone**: only one Phone textbox on the "Contact Address/Phone" tab. Currently fills it with `cellPhone || homePhone || workPhone`. The "Other Phone Numbers" tab exists for additional phones — not used yet.

## Verified Selectors

All selectors live inside the PeopleSoft iframe returned by `getContentFrame(page)` (main_target_win0). Use accessible role+name selectors — refs change per snapshot.

### HR Tasks sidebar (top-level page, not iframe)
- "Personal Data Related" link: `page.getByRole("link", { name: /^Personal Data Related/i })` (2026-04-14)
- "Emergency Contact" sub-link: `page.getByRole("link", { name: "Emergency Contact", exact: true })` (2026-04-14)

### Search page (iframe)
- Empl ID textbox: `frame.getByRole("textbox", { name: "Empl ID" })` (2026-04-14)
- Search button: `frame.getByRole("button", { name: "Search", exact: true })` (2026-04-14)
- "No matching values were found." literal text when no record exists (2026-04-14)
- "Drill in" link on multi-result grids: `frame.getByRole("link", { name: /drill in/i })` (2026-04-14)

### Edit form (iframe)
- Contact Name textbox: `frame.getByRole("textbox", { name: "Contact Name" })` (2026-04-14)
- Primary Contact checkbox: `frame.getByRole("checkbox", { name: "Primary Contact" })` (2026-04-14)
- Relationship combobox: `frame.getByRole("combobox", { name: "Relationship to Employee" })` (2026-04-14)
- Same Address as Employee checkbox: `frame.getByRole("checkbox", { name: "Same Address as Employee" })` (2026-04-14)
- Same Phone as Employee checkbox: `frame.getByRole("checkbox", { name: "Same Phone as Employee" })` (2026-04-14)
- Add a new row button: `frame.getByRole("button", { name: /add a new row/i })` (2026-04-14)
- Edit Address button: `frame.getByRole("button", { name: "Edit Address" })` (2026-04-14)
- Phone textbox (Contact Address/Phone tab): `frame.getByRole("textbox", { name: "Phone", exact: true })` (2026-04-14)
- Save button: `frame.getByRole("button", { name: "Save", exact: true })` (2026-04-14)
- Return to Search button: `frame.getByRole("button", { name: "Return to Search" })` (2026-04-14)

### Edit Address modal (iframe)
- Address 1 textbox: `frame.getByRole("textbox", { name: "Address 1" })` (2026-04-14)
- Address 2 textbox: `frame.getByRole("textbox", { name: "Address 2" })` (2026-04-14)
- City textbox: `frame.getByRole("textbox", { name: "City" })` (2026-04-14)
- State textbox: `frame.getByRole("textbox", { name: "State" })` (2026-04-14)
- Postal textbox: `frame.getByRole("textbox", { name: "Postal" })` (2026-04-14)
- OK button: `frame.getByRole("button", { name: "OK", exact: true })` (2026-04-14)
- Cancel button: `frame.getByRole("button", { name: "Cancel" })` (2026-04-14)

### Relationship dropdown — exact option labels (2026-04-14)
| value | label |
|-------|-------|
| C | Child |
| H | Contact if Detained/Arrested |
| NA | Domestic Partner Adult |
| NC | Domestic Partner Child |
| HA | Emerg/Detention/Arrest Contact |
| FR | Friend |
| GP | Grand Parent |
| GC | Grandchild |
| MD | Medical Provider |
| N | Neighbor |
| OT | Other |
| R | Other Relative |
| P | Parent |
| RO | Roommate |
| SB | Sibling |
| SP | Spouse |
| W | Ward |

**Important**: no "Mother"/"Father"/"Mom"/"Dad" options. All parental relationships map to **Parent**. Brother/Sister → **Sibling**. Grandma/Grandpa → **Grand Parent**. Aunt/Uncle/Cousin → **Other Relative**.

## Dashboard "Run" button (OCR prep — 2026-05-01)

As of 2026-05-01 the prep flow lives entirely in the `ocr` workflow (`src/workflows/ocr/`). The operator selects the `ocr` workflow in the TopBar, picks "Emergency contact" as form type, uploads a PDF. See `src/workflows/ocr/CLAUDE.md` for the full flow. The `prepare.ts`, `preview-schema.ts`, and `src/tracker/emergency-contact-http.ts` files were deleted in this migration.

**Legacy note (2026-04-28 — now superseded):** the original self-service flow was:

```
TopBar Run button (emergency-contact only)
  → RunModal (PDF upload + roster picker)
  → POST /api/emergency-contact/prepare (multipart, fire-and-forget)
    → runPrepare() in src/workflows/emergency-contact/prepare.ts:
      - synchronous: writes pending tracker row → loads roster → OCR via src/ocr/
      - synchronous: per-record match (form-EID > roster name match >= 0.85)
      - async: enqueue eid-lookup daemon for unmatched records
        + watches eid-lookup JSONL for completions, patches records progressively
      - terminal status: done (writes the records list to data.records)
  → PreviewRow renders at the top of QueuePanel (parsed from data.mode === "prepare")
  → User reviews/edits records inline (per-record edit form persisted to localStorage)
  → POST /api/emergency-contact/approve-batch:
    - validates each PreviewRecord, strips preview-only fields
    - runs through enqueueFromHttp → ensureDaemonsAndEnqueue (auto-spawn if needed)
    - marks prep row done with step="approved"
  → N child queue rows fan out, daemon claims them one at a time
```

The prep phase **bypasses the kernel** — `runPrepare` writes tracker rows directly via `trackEvent`. There is **no second workflow name**: the prep parent and its child rows all carry `workflow: "emergency-contact"`. The discriminator is `data.mode === "prepare"` on the parent vs. absent on the children.

Dashboard restart sweep: `sweepStuckPrepRows(dir)` runs at startDashboard time and marks any prep row in transient state (pending/running) as failed with a "Dashboard restarted while prepare was in progress — please re-upload" error. Implemented in `src/tracker/emergency-contact-http.ts`. The HTTP endpoints + restart sweep live in that same module so dashboard.ts route bodies stay short.

Frontend components (all under `src/dashboard/components/`):
- `TopBarRunButton.tsx` — primary CTA, scoped to workflow === "emergency-contact"
- `RunModal.tsx` — Radix Dialog with PDF dropzone + roster radio picker; XHR upload with progress
- `PreviewRow.tsx` — pinned at top of QueuePanel for any `data.mode === "prepare"` entry
- `PreviewRecordRow.tsx` — per-record summary + match badge + inline edit toggle
- `PreviewRecordEditForm.tsx` — inline expanded edit form (no nested modal)
- `preview-types.ts` — TypeScript mirrors of the backend Zod schemas (no runtime Zod in the bundle)

Backend endpoints (all in `src/tracker/dashboard.ts`, handlers in `src/tracker/emergency-contact-http.ts`):
- `GET  /api/rosters` — lists xlsx files in `.tracker/rosters/` and `src/data/`, newest first
- `POST /api/emergency-contact/prepare` — multipart/form-data; fire-and-forgets `runPrepare` and returns `{ok, parentRunId, pdfPath}` synchronously (the pending tracker row is written before runPrepare's first await)
- `POST /api/emergency-contact/approve-batch` — JSON; expands the user's `PreviewRecord[]` into N kernel inputs via `enqueueFromHttp`, marks prep row `done` step `approved`
- `POST /api/emergency-contact/discard-prepare` — JSON; emits `failed` step `discarded`, best-effort unlinks the uploaded PDF

Per-record edits are mirrored to localStorage at `ec-prep-edits:<parentRunId>` so a reload restores in-progress edits. Cleared on Approve / Discard.

## Lessons Learned

- **2026-04-28: OCR-to-Approve self-service flow shipped.** New `src/ocr/` primitive (Gemini multi-key + 7-provider fallback rotation, file-cached, schema-bound) generalizes the OCR concern across future workflows. Prep phase deliberately bypasses the kernel — the parent prep row carries records inline as `data.records` and only fans out to kernel items on Approve, so the dashboard sees one preview row → N child rows. Single workflow name throughout (`emergency-contact`); the `data.mode === "prepare"` discriminator distinguishes parent from children. Async EID resolution chain: prep handler enqueues into eid-lookup daemon with `ec-prep-`-prefixed itemIds (`ec-prep-<parentRunId>-r<index>`), watches the eid-lookup JSONL via `fs.watch` + 200ms polling fallback, patches the parent row's records progressively. Restart sweep in the dashboard's startup path marks stuck prep rows as failed (the OCR + eid-lookup polling lives in the dashboard's Node process, so a backend restart leaves any in-flight prep row orphaned). Three bugs ship in the same arc: fuzzy duplicate detection (Levenshtein ≤ 2 on normalized names) demotes the existing UCPath emergency contact's Primary Contact rather than skipping the new add (Leo Longley's case); same-address-when-null at the schema level via `EmergencyContactSchema.transform()` (Geonmoo Lee's blank-address case); dashboard `updateData` populates emplId / contactName / relationship / contactPhone / contactAddress at the top of the handler so the detail grid never shows "field declared but never populated". Full design + plan in `docs/superpowers/specs/2026-04-27-emergency-contact-run-button-ocr-design.md` and `docs/superpowers/plans/2026-04-27-emergency-contact-run-button-ocr-plan.md`.
- **2026-04-17: Migrated to kernel.** `runEmergencyContact` is a CLI adapter over `runWorkflowBatch(emergencyContactWorkflow, records, { onPreEmitPending })`. Dry-run bypasses the kernel (no browser); preflight (roster download + verify) still runs in the CLI adapter BEFORE `runWorkflowBatch` launches browsers. Don't reintroduce raw `launchBrowser` / `withTrackedWorkflow` calls in the handler — those live in `src/core/`. `onPreEmitPending` paired with pre-generated runId (kernel debt #1, commit 4e89687) avoids duplicate `pending` rows. **Live run pending user verification** — UCPath Duo can't be approved this session, so only dry-run + tests validate this migration. **Add-New flow still deferred** — `NoExistingContactError` from `navigateToEmergencyContact` now surfaces as a per-record `failed` via the kernel's `withTrackedWorkflow` wrapping (same as before); a separate plan will add the Add-New UCPath navigation path.
- **2026-04-17: Co-located `roster-verify.ts` + `sharepoint-download.ts`.** Both modules moved from `src/utils/` into `src/workflows/emergency-contact/` — they had exactly one consumer each. The `src/utils/` location implied broader reuse that never materialized. Dev-script consumers (`src/scripts/verify-batch-against-roster.ts`, `src/scripts/download-sharepoint-roster.ts`) now import across workflow boundary; that's fine for dev-only scripts.
- **2026-04-22: `sharepoint-download.ts` promoted out of this directory** into `src/workflows/sharepoint-download/` once the dashboard queue-header button made it cross-cutting (every workflow can trigger the download, not just emergency-contact). The pre-flight `runPreflight()` and the dev CLI wrapper both still import `downloadSharePointFile` directly (bypassing the kernel — preflight already runs inside this workflow's kernel run, and nesting would double-emit tracker rows). Same afternoon, sharepoint-download was promoted to a full kernel workflow so dashboard clicks get per-run logs + queue rows + session-panel boxes — see `src/workflows/sharepoint-download/CLAUDE.md`.
- **2026-04-14: `#pt_modalMask` intercepts clicks** — PeopleSoft leaves a transparent `#pt_modalMask` element visible even when no modal is open, causing every Playwright click to fail with "subtree intercepts pointer events" and retry forever. Fix: `hidePeopleSoftModalMask(page)` (exported from `src/systems/ucpath/personal-data.ts`) evals `document.getElementById('pt_modalMask').style.display='none'` before any click. Called before Search click, Add-new-row, Edit Address, OK, and Save.
- **2026-04-14: `Name begins with` search returns nothing** — The Emergency Contact page's "Find an Existing Value" search ONLY returns employees who already have at least one emergency contact record on file. Blank searches and name searches with no existing records both return "No matching values were found." For the batch of new hires (who have zero existing contacts), this search will fail — we need a different path for the Add-New case. Currently raises `NoExistingContactError`; **Add-New flow is NOT YET IMPLEMENTED**.
- **2026-04-14: Batch OCR errors caught by roster** — Catherine Morales Rojas's EID was OCR'd as `10871272` but the correct value is `10871222`. Pre-flight roster verification (`--roster-url`) catches these before any transaction runs.
