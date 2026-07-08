# Emergency Contact Workflow

Fills the Emergency Contact form in UCPath HR Tasks → Personal Data Related for records approved from the dashboard OCR prep flow.

**Kernel-based.** Declared via `defineWorkflow` in `workflow.ts`. The operator start path is dashboard upload run → `/api/ocr/prepare` with `formType: "emergency-contact"` → OCR approval → daemon enqueue of approved records. The old YAML batch adapter has been removed; Emergency Contact is not an input-run workflow.

**Add-New contact flow is NOT YET IMPLEMENTED** — employees with zero existing emergency contacts fail with `NoExistingContactError`; see Gotchas for the current behavior.

## Selector intelligence

This workflow touches one system: **ucpath** (HR Tasks → Personal Data Related → Emergency Contact).

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"emergency contact"`, `"hr tasks navigation"`, `"relationship dropdown"`).
- Per-system lessons (read before re-mapping): [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
- Per-system catalog (auto-generated): [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)

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

Lives in the sibling [`sharepoint-download/`](../sharepoint-download/) workflow — see its CLAUDE.md for the full story. TL;DR: the Download dropdown in every queue-panel header fires `POST /api/sharepoint-download/run` (backed by `buildSharePointRosterDownloadHandler`), which reads `ONBOARDING_ROSTER_URL` from env and saves the xlsx to `.tracker/sharepoint/`. As of 2026-04-22 sharepoint-download IS a kernel workflow (appears in the TopBar dropdown as "SharePoint Download") so operators can see per-run logs + queue rows + session-panel progress. The HTTP endpoint is fire-and-forget (202) — progress is observed in the Sessions panel, not via the response body.

## Roster verification

Optional but recommended before enqueuing. Two standalone scripts handle ad-hoc roster work:

- **`tsx src/workflows/emergency-contact/scripts/download-roster.ts "<sharepoint-url>"`** — downloads a roster from SharePoint (via `downloadSharePointFile`; handles SSO + Duo) and saves to `.tracker/rosters/`.
- **`tsx src/workflows/emergency-contact/scripts/verify-roster.ts <batchYaml> <rosterXlsxOrCsv>`** — verifies a batch YAML against a local roster file using `verifyBatchAgainstRoster` in `roster-verify.ts`.

`verifyBatchAgainstRoster` checks:
- Finds `Employee ID` column and `Name` column (or `First Name` + `Last Name`) in row 1 headers
- For each batch record: checks EID exists + name words intersect (case-insensitive, tolerates "Doe, Jane" vs "Jane Doe")

Roster checks also run in the dashboard OCR approval path before records are enqueued.

## Gotchas

- **Add-New path not yet implemented**: When a target employee has no existing emergency contact on file, `navigateToEmergencyContact` throws `NoExistingContactError`. The kernel's `withTrackedWorkflow` wrapping records the record as `failed` and the batch continues to the next record. A different UCPath navigation path is needed for the Add case (probably NavBar → Workforce Administration → Personal Information → Biographical → Personal Data). A separate future plan covers this.
- **`#pt_modalMask` intercepts clicks** — must hide via `dismissPeopleSoftModalMask(page)` before every click. Already done for Search / Add-new-row / Edit Address / OK / Save in `enter.ts`.
- **Per-record error handling**: one record failing does not abort the in-process batch. `runWorkflowBatch` wraps each record in its own `withTrackedWorkflow` — errors land as `failed` tracker entries; the loop moves on. The final summary line reports `N/M succeeded, K failed` and prints up to 3 error messages. (Daemon mode: each row is its own queued task; use the dashboard queue for per-record status.)
- **Auth once, use many**: UCPath auth runs once via the kernel's `Session.launch` at the top of the batch; the same browser page is reused for all records. Between records the kernel calls `session.reset("ucpath")` (no-op here since UCPath's system config has no `resetUrl`, and `navigateToEmergencyContact` performs an absolute navigation anyway).
- **Address "same as employee" is computed during extraction** — not on the paper form. YAML has the boolean already.
- **Phone**: only one Phone textbox on the "Contact Address/Phone" tab. Currently fills it with `cellPhone || homePhone || workPhone`. The "Other Phone Numbers" tab exists for additional phones — not used yet.

## Dashboard: PDF → YAML path (OCR)

Handwritten emergency-contact PDFs are prepped through the **`ocr` workflow** in the dashboard Run flow: select **`ocr`** in the TopBar, choose form type **Emergency contact**, upload the PDF, review extracted records, then approve to enqueue **`emergency-contact`** kernel items (daemon queue).

The **Run Emergency Contact** button (`targetWorkflow="emergency-contact"`) creates an `operation` coordinator row in the Emergency Contact panel at `/api/ocr/prepare`; the OCR run is delegated under it and the approved contact rows parent to it as inline expandable member rows (OCR status before approval). The OCR review row stays the one real row in the OCR panel. See `src/workflows/ocr/CLAUDE.md` (2026-06-03 operation-tracking lesson).

- **HTTP:** `/api/ocr/*` — see [`src/tracker/dashboard/hono/routes/ocr.ts`](../../tracker/dashboard/hono/routes/ocr.ts) and handlers under [`src/tracker/dashboard/ocr/`](../../tracker/dashboard/ocr/).
- **Operator narrative:** [`src/workflows/ocr/CLAUDE.md`](../ocr/CLAUDE.md).

**Historical (do not treat as live paths):** per-workflow `/api/emergency-contact/*` routes, `src/workflows/emergency-contact/prepare.ts`, and `src/tracker/emergency-contact-http.ts` were removed when prep consolidated on OCR; old design notes may still appear under `docs/superpowers/`.

## Lessons Learned

- **Lesson maintenance rule:** Search this section and `src/workflows/ocr/CLAUDE.md` before adding emergency-contact prep/batch guidance. Merge old per-workflow prep notes into the current shared-OCR model.
- **2026-07-01: OCR roster trust skips person-lookup when SharePoint EID+name align.** Emergency-contact OCR `matchRecord` now cross-checks form EIDs against the onboarding roster (`UCPath ID` column) using `classifyNameSimilarity` — exact or similar names stamp `rosterNameTrust` and `needsLookup` returns null (no person-lookup fan-out). EID on roster but a different name → `lookup-pending` + verify; EID absent from roster → verify. Edit Data is opted in: editable `detailFields` + `applyPrefilledToEmergencyContactRecord` let operators fix EID/contact/address after approval and rerun via `/api/run-with-data` without re-OCR; because the row's `contactPhone`/`contactAddress` are derived display summaries (built by the shared `buildContactPhoneSummary`/`buildContactAddressSummary` in `prefilled-record.ts`) and EditDataTab submits untouched fields too, the overlay skips any value that merely round-trips the record's own summary — otherwise an unedited rerun would cram the whole address into `address.street` (blanking city/state/zip) and reclassify a home/work-only phone as `cellPhone`.
- **OCR prep is shared.** Dashboard prep/review/approve for emergency-contact PDFs routes through `/api/ocr/*` and the shared OCR handler stack. The removed per-workflow `/api/emergency-contact/*`, `prepare.ts`, and `src/tracker/emergency-contact-http.ts` paths are historical only.
- **2026-05-25: Dashboard upload run is the public start path.** `npm run emergency-contact <batchYaml>` and the YAML adapters were removed. Operators start Emergency Contact from the dashboard upload run, review OCR, then approve records into daemon rows. Do not expose batch YAML as a package script, dashboard input-run option, or exported workflow helper.
- **Kernel/daemon shape is current.** Approved OCR records enqueue daemon tasks directly; the workflow module should not grow a separate YAML/in-process start adapter. Do not reintroduce raw `launchBrowser` or `withTrackedWorkflow` in the handler.
- **Add-New remains deferred.** The Find Existing Value search only finds employees with at least one emergency contact. Zero-contact employees throw `NoExistingContactError`, emit a failed row, and the batch continues.
- **PeopleSoft modal mask must be dismissed.** `#pt_modalMask` can intercept clicks even with no visible modal; keep `dismissPeopleSoftModalMask(page)` before Search, Add-new-row, Edit Address, OK, and Save clicks.
- **Primary contact save recovery (2026-07-06):** when Save returns PeopleSoft `(1000,110)` / "Only one emergency contact can be indicated as the primary contact", `saveEmergencyContactWithPrimaryRecovery` dismisses the Message dialog, demotes other rows' Primary Contact checkboxes (keeping the new contact at row 1 primary), and retries Save once. If no other primary was found to demote, it unchecks Primary Contact on the new contact row instead.
- **Roster verification catches OCR EID errors.** Keep roster checks in the dashboard OCR approval path before browser work; it caught real OCR digit drift (for example `10871272` vs `10871222`) before a transaction ran.
- **SharePoint download is cross-cutting.** The roster downloader moved to `src/workflows/sharepoint-download/` once the dashboard queue-header button made it reusable. Emergency-contact preflight and dev scripts may import the helper directly; dashboard-triggered downloads use the sharepoint-download workflow.
