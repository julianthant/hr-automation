# Emergency Contact Workflow

Fills the Emergency Contact form in UCPath HR Tasks → Personal Data Related for every record in a batch YAML. Fully autonomous after verification: you verify the YAML once (pre-extracted by Claude reading the handwritten PDF), then the workflow runs unattended for all records.

**Kernel-based.** Declared via `defineWorkflow` in `workflow.ts` and executed through `src/core/runWorkflowBatch` (sequential mode, `preEmitPending: true`, `betweenItems: ["reset-browsers"]`). The kernel owns browser launch, UCPath auth, per-record tracker entries, SIGINT cleanup. The CLI adapter `runEmergencyContact` owns pre-kernel phases: YAML load, dry-run short-circuit, optional SharePoint roster download + verify. **Add-New contact flow (when the target employee has zero existing emergency contacts) is NOT YET IMPLEMENTED** — `navigateToEmergencyContact` throws `NoExistingContactError`, the kernel records the record as `failed`, batch continues.

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
- `sharepoint-download.ts` — Opens SharePoint via UCSD SSO + Duo, triggers Download, saves to `outDir`. Co-located with its only consumer (moved from `src/utils/`).
- `workflow.ts` — Kernel definition (`emergencyContactWorkflow`) + CLI adapter (`runEmergencyContact`). Dry-run branch bypasses the kernel (no browser launch; logs each record's planned action).
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
    → if --dry-run: log each record, exit 0 (no browser)
    → else:
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

## Pre-flight roster verification

Optional but recommended. `--roster-url` downloads the latest roster from SharePoint (via `downloadSharePointFile` — handles SSO + Duo); `--roster-path` uses a local xlsx you already have. Uses `verifyBatchAgainstRoster` in `src/workflows/emergency-contact/roster-verify.ts`:

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

## Lessons Learned

- **2026-04-17: Migrated to kernel.** `runEmergencyContact` is a CLI adapter over `runWorkflowBatch(emergencyContactWorkflow, records, { onPreEmitPending })`. Dry-run bypasses the kernel (no browser); preflight (roster download + verify) still runs in the CLI adapter BEFORE `runWorkflowBatch` launches browsers. Don't reintroduce raw `launchBrowser` / `withTrackedWorkflow` calls in the handler — those live in `src/core/`. `onPreEmitPending` paired with pre-generated runId (kernel debt #1, commit 4e89687) avoids duplicate `pending` rows. **Live run pending user verification** — UCPath Duo can't be approved this session, so only dry-run + tests validate this migration. **Add-New flow still deferred** — `NoExistingContactError` from `navigateToEmergencyContact` now surfaces as a per-record `failed` via the kernel's `withTrackedWorkflow` wrapping (same as before); a separate plan will add the Add-New UCPath navigation path.
- **2026-04-17: Co-located `roster-verify.ts` + `sharepoint-download.ts`.** Both modules moved from `src/utils/` into `src/workflows/emergency-contact/` — they had exactly one consumer each. The `src/utils/` location implied broader reuse that never materialized. Dev-script consumers (`src/scripts/verify-batch-against-roster.ts`, `src/scripts/download-sharepoint-roster.ts`) now import across workflow boundary; that's fine for dev-only scripts.
- **2026-04-14: `#pt_modalMask` intercepts clicks** — PeopleSoft leaves a transparent `#pt_modalMask` element visible even when no modal is open, causing every Playwright click to fail with "subtree intercepts pointer events" and retry forever. Fix: `hidePeopleSoftModalMask(page)` (exported from `src/systems/ucpath/personal-data.ts`) evals `document.getElementById('pt_modalMask').style.display='none'` before any click. Called before Search click, Add-new-row, Edit Address, OK, and Save.
- **2026-04-14: `Name begins with` search returns nothing** — The Emergency Contact page's "Find an Existing Value" search ONLY returns employees who already have at least one emergency contact record on file. Blank searches and name searches with no existing records both return "No matching values were found." For the batch of new hires (who have zero existing contacts), this search will fail — we need a different path for the Add-New case. Currently raises `NoExistingContactError`; **Add-New flow is NOT YET IMPLEMENTED**.
- **2026-04-14: Batch OCR errors caught by roster** — Catherine Morales Rojas's EID was OCR'd as `10871272` but the correct value is `10871222`. Pre-flight roster verification (`--roster-url`) catches these before any transaction runs.
