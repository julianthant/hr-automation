# Person Match Workflow

Checks whether a person **already exists in UCPath** — the found / not-found
answer — via the HR-Tasks person search that onboarding uses to discriminate
new hires from rehires. This is a **delegated-only** subworkflow wrapping the
pluggable `searchPerson` module (`src/systems/ucpath/navigate.ts`).

## What it does

1. Accepts a person identified by legal name plus at least one hard
   identifier — SSN (9 bare digits) or date of birth (MM/DD/YYYY).
2. Authenticates to UCPath (`loginToUCPath`, eager single-system launch).
3. Runs `searchPerson(page, ssn, firstName, lastName, dob)` — fills the
   PERSON_SEARCH form, races the results grid (found) against the "no matching
   person" dialog (not found), and **throws** on an ambiguous outcome (never
   guesses; see the duplicate-person rationale in `navigate.ts`).
4. Emits `found` plus the first results-grid match's EID/name when found.

## Data flow

**In:** `{ lastName, firstName, ssn?, dob?, parentSubject? }` — schema
**rejects** an input with neither `ssn` nor `dob` (UCPath person search offers
only NID-based or DOB-based search orders; a name-only search can't run).
**Out (via `ctx.updateData`):** `{ found: "true"|"false", matchedEmplId,
matchedName }` (match fields empty when not found or the grid was unreadable).

A completed not-found run promotes to the shared **`notFound`** display badge
via `statusExtensions` (`src/domain/person-match-status.ts` — mirrors
person-lookup's rule).

## Kernel config

| Field | Value |
|-------|-------|
| `name` | `"person-match"` |
| `label` | `"Person Match"` |
| `archetype` | `"single"` — one person, one row |
| `inputSubject` | `"name"` → `queueRowKind: "person"` |
| `code` | `"pm"` |
| `category` | `"Search"` |
| `systems` | `[{ id: "ucpath", login: loginToUCPath }]` — kernel auto-prepends `auth:ucpath` |
| `steps` | `["search"]` |

## Start surface

**None.** No dashboard input-run or upload-run entry. Invoked only by parent
workflows via `ctx.delegateTo` / `ctx.delegateToAll` — today the **`i9` OCR
form spec** (`src/services/ocr/forms/i9.ts`) fans out one person-match per
extracted I-9 record (itemId `ocr-i9-<ocrRunId>-r<index>`), launched from the
separations panel's "Run I-9 Check" upload modal.

## Wiring

- `src/core/workflow-loaders.ts` — `"person-match"` entry (daemon loader).
- `src/tracker/dashboard/workflows.ts` — eager import for `/api/workflow-definitions`.
- `src/tracker/session-events.ts` — `INSTANCE_LABELS["person-match"] = "Person Match"`.
- `src/domain/queue-row-status-index.ts` — client-side `statusExtensions` registration.
- NOT in `DASHBOARD_INPUT_RUN_WORKFLOWS` or `DASHBOARD_UPLOAD_RUN_WORKFLOWS`.

## Person Match vs Person Lookup

Do **not** merge these. `person-lookup` resolves a KNOWN person's details
(Person Org Summary by EID or name — department, active status, CRM dates).
`person-match` answers a different question — *does UCPath know this person at
all?* — through the Search/Match form (`personSearch.*` selectors), which is
keyed on SSN/DOB and is the same duplicate-person gate onboarding runs before
creating a Smart HR transaction. The underlying primitive stays in
`src/systems/ucpath/navigate.ts` so both onboarding and this workflow share
one verified implementation.

## Lessons Learned

None yet.
