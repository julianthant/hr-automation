# Emergency Contact Workflow

Fills the Emergency Contact form in UCPath HR Tasks → Personal Data Related for records approved from the dashboard OCR prep flow.

**Kernel-based.** Declared via `defineWorkflow` in `workflow.ts`. The operator start path is dashboard upload run → `/api/ocr/prepare` with `formType: "emergency-contact"` → OCR approval → daemon enqueue of approved records. The old YAML batch adapter has been removed; Emergency Contact is not an input-run workflow.

**Add-New contact flow is NOT YET IMPLEMENTED** — employees with zero existing emergency contacts fail with `NoExistingContactError`; see Gotchas for the current behavior.

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
- Roster + name/address matching primitives live in [`src/services/matching/`](../../services/matching/) — shared with OCR orchestration (`formType: "emergency-contact"`) and other workflows.
- SharePoint download lives in its own sibling workflow: [`src/workflows/sharepoint-download/`](../sharepoint-download/). Use `import { downloadSharePointFile } from "../sharepoint-download/index.js"`. (Moved out of this directory 2026-04-22 once the dashboard roster-download button made it cross-cutting.)
- `workflow.ts` — Kernel definition (`emergencyContactWorkflow`) and shared display helper `buildEmergencyContactPendingData`.
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
| `batch` | `{ mode: "sequential", preEmitPending: true, betweenItems: ["reset"] }` |
| `detailFields` | Six labeled fields — `employeeName`, `emplId`, `contactName`, `relationship`, `contactPhone`, `contactAddress` (all `editable: true` in `workflow.ts`) |
| `archetype` | `"batch"` — one parent over N record items. The OCR prep parent (when emergency-contact is the OCR target) is stamped `batch-parent` separately. |

### Row archetypes emitted

| Row                                 | Archetype       | Dashboard surface                |
|-------------------------------------|-----------------|----------------------------------|
| Per-record item (approved record)   | `batch-member`  | Member chip in batch card        |
| OCR-prep parent (in OCR workflow)   | `batch-parent`  | Group card (top-level)           |
| Child run dispatched from OCR-approve | `delegate-child` | Nested under OCR parent card  |

## Data Flow

```
Dashboard upload run:
  → RunModal posts `/api/ocr/prepare` with `formType: "emergency-contact"`
  → OCR review/approval derives emergency-contact records
  → ensureDaemonsAndEnqueue → per-record `pending` rows + SQLite queue

Approved daemon task:
  → Kernel Session.launch: 1 browser, UCPath auth (Duo ×1)
  → Handler: `navigation` → `fill-form` → `save` (see `workflow.ts`)
```

## Item ID shape

`p{NN}-{emplId}` — zero-padded source page + EID. Stable across re-runs from the same OCR source; tolerates EID collisions across pages.

## Historical Batch YAML Layout

This shape is retained only for fixtures and OCR service transforms. It is not a public dashboard input-run option or exported workflow helper input.

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
- Roster checks belong in the dashboard OCR approval path before records are enqueued.

## Dashboard integration

- Workflow name: `emergency-contact`
- Steps (in order): `navigation` → `fill-form` → `save`
- **`detailFields`:** six editable columns from `workflow.ts` (Employee, Empl ID, Contact, Relationship, Contact Phone, Contact Address) — populated at handler start + `onPreEmitPending` for daemon rows
- Pending row payload: `buildEmergencyContactPendingData` (`batchName`, `sourcePage`, `emplId`, `employeeName`, `contactName`, `relationship`, optional `dryRun`)
- Handler `updateData` extensions: `skipped` + `skipReason`, `contactPhone` / `contactAddress` summaries, optional `fuzzyDemote*` fields

## Gotchas

- **Add-New path not yet implemented**: When a target employee has no existing emergency contact on file, `navigateToEmergencyContact` throws `NoExistingContactError`. The kernel's `withTrackedWorkflow` wrapping records the record as `failed` and the batch continues to the next record. A different UCPath navigation path is needed for the Add case (probably NavBar → Workforce Administration → Personal Information → Biographical → Personal Data). A separate future plan covers this.
- **`#pt_modalMask` intercepts clicks** — must hide via `dismissPeopleSoftModalMask(page)` before every click. Already done for Search / Add-new-row / Edit Address / OK / Save in `enter.ts`.
- **Per-record error handling**: one record failing does not abort the in-process batch. `runWorkflowBatch` wraps each record in its own `withTrackedWorkflow` — errors land as `failed` tracker entries; the loop moves on. The final summary line reports `N/M succeeded, K failed` and prints up to 3 error messages. (Daemon mode: each row is its own queued task; use the dashboard queue for per-record status.)
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

## Dashboard: PDF → YAML path (OCR)

Handwritten emergency-contact PDFs are prepped through the **`ocr` workflow** in the dashboard Run flow: select **`ocr`** in the TopBar, choose form type **Emergency contact**, upload the PDF, review extracted records, then approve to enqueue **`emergency-contact`** kernel items (daemon queue).

- **HTTP:** `/api/ocr/*` — see [`src/tracker/dashboard/hono/routes/ocr.ts`](../../tracker/dashboard/hono/routes/ocr.ts) and handlers under [`src/tracker/dashboard/ocr/`](../../tracker/dashboard/ocr/).
- **Operator narrative:** [`src/workflows/ocr/CLAUDE.md`](../ocr/CLAUDE.md).

**Historical (do not treat as live paths):** per-workflow `/api/emergency-contact/*` routes, `src/workflows/emergency-contact/prepare.ts`, and `src/tracker/emergency-contact-http.ts` were removed when prep consolidated on OCR; old design notes may still appear under `docs/superpowers/`.

## Lessons Learned

- **Lesson maintenance rule:** Search this section and `src/workflows/ocr/CLAUDE.md` before adding emergency-contact prep/batch guidance. Merge old per-workflow prep notes into the current shared-OCR model.
- **OCR prep is shared.** Dashboard prep/review/approve for emergency-contact PDFs routes through `/api/ocr/*` and the shared OCR handler stack. The removed per-workflow `/api/emergency-contact/*`, `prepare.ts`, and `src/tracker/emergency-contact-http.ts` paths are historical only.
- **2026-05-25: Dashboard upload run is the public start path.** `npm run emergency-contact <batchYaml>` and the YAML adapters were removed. Operators start Emergency Contact from the dashboard upload run, review OCR, then approve records into daemon rows. Do not expose batch YAML as a package script, dashboard input-run option, or exported workflow helper.
- **Kernel/daemon shape is current.** Approved OCR records enqueue daemon tasks directly; the workflow module should not grow a separate YAML/in-process start adapter. Do not reintroduce raw `launchBrowser` or `withTrackedWorkflow` in the handler.
- **Add-New remains deferred.** The Find Existing Value search only finds employees with at least one emergency contact. Zero-contact employees throw `NoExistingContactError`, emit a failed row, and the batch continues.
- **PeopleSoft modal mask must be dismissed.** `#pt_modalMask` can intercept clicks even with no visible modal; keep `dismissPeopleSoftModalMask(page)` before Search, Add-new-row, Edit Address, OK, and Save clicks.
- **Roster verification catches OCR EID errors.** Keep roster checks in the dashboard OCR approval path before browser work; it caught real OCR digit drift (for example `10871272` vs `10871222`) before a transaction ran.
- **SharePoint download is cross-cutting.** The roster downloader moved to `src/workflows/sharepoint-download/` once the dashboard queue-header button made it reusable. Emergency-contact preflight and dev scripts may import the helper directly; dashboard-triggered downloads use the sharepoint-download workflow.
