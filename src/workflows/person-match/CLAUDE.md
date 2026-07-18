# Person Match Workflow

Checks whether a person **already exists in UCPath** — the found / not-found
answer — via the HR-Tasks person search that onboarding uses to discriminate
new hires from rehires. This is a **delegated-only** subworkflow wrapping the
pluggable `searchPerson` module (`src/systems/ucpath/navigate.ts`).

> **NO DELEGATED CALLER (2026-07-16 / still true 2026-07-17).** The i9 OCR
> form spec no longer fans out person-match children. I-9 Check members
> (`src/workflows/i9-check/check.ts`) reuse the underlying **`searchPerson`**
> primitive in-process at the `person-match` step — they do **not**
> `ctx.delegateTo` this workflow. The workflow stays registered (historical
> rows still resolve, and it remains the ready-made delegated wrapper if a
> future parent needs an in-flight person check), but do not build new
> delegated features on it without a real caller.

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

**None.** No dashboard input-run or upload-run entry. Designed for parent
workflows via `ctx.delegateTo` / `ctx.delegateToAll`, but **no current
delegated caller**. I-9 Check calls `searchPerson` in-process instead (see
above).

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

- **2026-07-13: The UCPath results-grid selector was DEAD, so a found person could never be reported — only "not found" ever worked.** `searchPerson` decides found-vs-not-found by racing the results grid against the "no matching person" dialog. The grid arm (`personSearch.resultRows`, `[id*="SEARCH_RESULT"] tr, .PSLEVEL1GRID tr`) matched **0 elements** on the real PERSON_RESULTS page — its grid is `table#l0PERSON$0` with `span#EMPLID$<n>` cells — so a genuine match sat unseen until the 15s race window expired and the run threw the fail-loud "neither signal appeared" ambiguity error. In the 2026-07-10 I-9 batch that was **25 of 104 person-match runs failed**, and every one of the 79 "successes" was a not-found (the only outcome the code could physically detect). Fixed by `personSearch.resultEmplIdCells` + per-row-id field extraction (`EMPLID$<n>`/`HTML2$<n>`/`HTML4$<n>` — the grid nests tables, so positional `td`-walking double-reads cells). **The transferable lesson:** when a fail-loud guard keeps firing on one branch of a race, suspect the branch that *never* fires — a dead selector in a race produces a timeout, not an error naming the selector. Full write-up + live probe: `src/systems/ucpath/LESSONS.md` (2026-07-13).
