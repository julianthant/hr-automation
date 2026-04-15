# Emergency Contact Workflow

Fills the Emergency Contact form in UCPath HR Tasks → Personal Data Related for every record in a batch YAML. Fully autonomous after verification: you verify the YAML once (pre-extracted by Claude reading the handwritten PDF), then the workflow runs unattended for all records.

## Files

- `schema.ts` — Zod schemas + YAML loader (`loadBatch`). Top-level `BatchSchema` = `{ pdfPath, batchName, records[] }`. Each record has `employee` (informational), `emergencyContact` (UCPath input), `sourcePage`, `notes[]`.
- `config.ts` — `RELATIONSHIP_MAP` (raw handwritten text → UCPath dropdown value), `HR_TASKS_URL`, `TRACKER_DIR`, `ROSTERS_DIR`. Aliases for "Mom", "Dad", "Parent", "Guardian", etc.
- `enter.ts` — `buildEmergencyContactPlan(record, page, frame, ctx)` returns an `ActionPlan` with: Add → Fill name → Check Primary → Select Relationship → Same-Address toggle (fill manual address if not same) → Fill phone → Save.
- `workflow.ts` — `runEmergencyContactBatch(yamlPath, options)`. Phases: load → pre-flight (roster download + verify) → pre-emit `pending` for all records → launch + auth UCPath once → per-record navigate+fill+save wrapped in `withTrackedWorkflow`.
- `index.ts` — Barrel.

No `tracker.ts` — dashboard JSONL only (see `src/workflows/CLAUDE.md`).

## Data Flow

```
Handwritten PDF  ──(Claude reads pages via Read tool, writes YAML)──►  batch-YYYY-MM-DD.yml
                                                                              │
                                                                              ▼
                                                                       loadBatch (Zod validate)
                                                                              │
                                                                              ▼
                                                     [optional] SharePoint roster download
                                                              + verify EID/name against roster
                                                                              │
                                                                              ▼
                                                                  pre-emit pending × N (dashboard queue)
                                                                              │
                                                                              ▼
                                                              Launch browser, UCPath auth (Duo ×1)
                                                                              │
                                                           ┌──────────────────┴───────────────────┐
                                                           │  For each record:                    │
                                                           │    navigateToEmergencyContact(emplId)│
                                                           │    buildEmergencyContactPlan.execute │
                                                           │    → done / failed tracker event     │
                                                           └──────────────────────────────────────┘
```

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

Optional but recommended. `--roster-url` downloads the latest roster from SharePoint (via `downloadSharePointFile` utility — handles SSO + Duo); `--roster-path` uses a local xlsx you already have. Uses `verifyBatchAgainstRoster` in `src/utils/roster-verify.ts`:

- Finds `Employee ID` column and `Name` column (or `First Name` + `Last Name`) in row 1 headers
- For each batch record: checks EID exists + name words intersect (case-insensitive, tolerates "Doe, Jane" vs "Jane Doe")
- Aborts on mismatches unless `--ignore-roster-mismatch`

## Dashboard integration

- Workflow name: `emergency-contact`
- Steps (in order): `navigation` → `fill-form` → `save`
- Item ID: `p{NN}-{emplId}` (zero-padded source page + EID — stable across re-runs)
- Detail fields: Employee, Empl ID, Contact, Relationship
- `updateData()` populated with: `batchName, sourcePage, emplId, employeeName, contactName, relationship`

## Gotchas

- **Add-New path not yet implemented**: When a target employee has no existing emergency contact on file, `navigateToEmergencyContact` throws `NoExistingContactError` and the workflow marks that record failed. A different UCPath navigation path is needed for the Add case (probably NavBar → Workforce Administration → Personal Information → Biographical → Personal Data). See CLAUDE.md Lessons Learned.
- **`#pt_modalMask` intercepts clicks** — must hide via `hidePeopleSoftModalMask(page)` before every click. Already done for Search / Add-new-row / Edit Address / OK / Save in `enter.ts`.
- **Per-record error handling**: one record failing does not abort the batch. Errors are logged + the record gets a `failed` tracker entry; the loop moves on.
- **Auth once, use many**: UCPath auth runs once at the top of the batch; browser + session are reused for all 18+ records. No re-auth between records.
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

- **2026-04-14: `#pt_modalMask` intercepts clicks** — PeopleSoft leaves a transparent `#pt_modalMask` element visible even when no modal is open, causing every Playwright click to fail with "subtree intercepts pointer events" and retry forever. Fix: `hidePeopleSoftModalMask(page)` (exported from `src/systems/ucpath/personal-data.ts`) evals `document.getElementById('pt_modalMask').style.display='none'` before any click. Called before Search click, Add-new-row, Edit Address, OK, and Save.
- **2026-04-14: `Name begins with` search returns nothing** — The Emergency Contact page's "Find an Existing Value" search ONLY returns employees who already have at least one emergency contact record on file. Blank searches and name searches with no existing records both return "No matching values were found." For the batch of new hires (who have zero existing contacts), this search will fail — we need a different path for the Add-New case. Currently raises `NoExistingContactError`; **Add-New flow is NOT YET IMPLEMENTED**.
- **2026-04-14: Batch OCR errors caught by roster** — Catherine Morales Rojas's EID was OCR'd as `10871272` but the correct value is `10871222`. Pre-flight roster verification (`--roster-url`) catches these before any transaction runs.
