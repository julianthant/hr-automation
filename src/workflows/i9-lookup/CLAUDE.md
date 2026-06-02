# I9 Lookup Workflow

Resolves **who signed Section 2 of an employee's I-9 form** — the "authorized representative" or oath signer. This is a **delegated-only** subworkflow wrapping `lookupSection2Signer` from `src/systems/i9/signer.ts`.

## What it does

1. Accepts a person identified by last + first name (I-9 Complete's search is name-based, not EID-based).
2. Authenticates to I9 Complete via `loginToI9` (email + password; no Duo MFA).
3. Searches I9 Complete for the employee using `searchI9Employee` (invoked internally by `lookupSection2Signer`).
4. Navigates to the I-9 record summary and reads the "Signed Section 2" audit row.
5. Emits `signerName` (who signed, or empty string if unsigned/error) and `i9Status` ("signed" | "unsigned" | "historical" | "not-found" | "error").

## Data flow

**In:** `{ lastName, firstName, ssn?, parentSubject? }`
**Out (via `ctx.updateData`):** `{ signerName, i9Status, profileId? }`

- `signerName` — the name of the authorized representative who signed Section 2, or `""` when the I-9 was not signed electronically.
- `i9Status` — one of `"signed"`, `"unsigned"`, `"historical"` (paper import), `"not-found"`, or `"error"`.
- `profileId` — the I-9 employee profile ID (only when the search reached the summary page).

## Kernel config

| Field | Value |
|-------|-------|
| `name` | `"i9-lookup"` |
| `label` | `"I9 Lookup"` |
| `archetype` | `"single"` — one person, one row |
| `inputSubject` | `"name"` → `queueRowKind: "person"` |
| `code` | `"i9"` |
| `category` | `"Utils"` |
| `systems` | `[{ id: "i9", login: loginToI9 }]` — kernel auto-prepends `auth:i9` step |
| `steps` | `["lookup"]` |

## Start surface

**None.** This workflow has no dashboard input-run or upload-run entry. It is invoked only by parent workflows via `ctx.delegateTo` / `ctx.delegateToAll`. It is registered in `WORKFLOW_LOADERS` so the daemon/enqueue path can resolve it when a parent delegates.

## Wiring

- `src/core/workflow-loaders.ts` — `"i9-lookup"` entry (daemon loader).
- `src/tracker/dashboard/workflows.ts` — eager import for `/api/workflow-definitions`.
- `src/tracker/session-events.ts` — `INSTANCE_LABELS["i9-lookup"] = "I9 Lookup"`.
- NOT in `DASHBOARD_INPUT_RUN_WORKFLOWS` or `DASHBOARD_UPLOAD_RUN_WORKFLOWS`.

## I-9 search is name-based

`I9SearchCriteria` accepts `lastName`, `firstName`, `ssn`, `profileId`, `employeeId`. The I-9 search interface requires at least one of `lastName`, `ssn`, `employeeId`, or `profileId`. This workflow always provides `lastName` + `firstName`; `ssn` is optional for disambiguation.

**Do NOT change the input to EID-based.** I9 Complete's search does not accept UCPath EIDs natively — you would need to provide `employeeId` which is the I9 Complete employee ID (distinct from UCPath's `emplId`).

## Underlying primitive

`lookupSection2Signer` in `src/systems/i9/signer.ts`:
- Calls `searchI9Employee` to find the record.
- Picks the first result (search returns newest first; multi-match is rare).
- Navigates to `/form-I9/summary/{profileId}/{i9Id}`.
- Paper imports redirect to `/form-I9-historical/…` → `status: "historical"`.
- Reads the "Signed Section 2" audit-trail row (columns: Section, Date, Event, Created By — signer is cell index 3).

See `src/systems/i9/CLAUDE.md` and `src/systems/i9/LESSONS.md` for selector history and gotchas.

## Lessons Learned

None yet.
