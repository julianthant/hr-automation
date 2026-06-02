# I9 Lookup Workflow

## What It Does

I9 Lookup resolves who signed Section 2 of an employee's I-9 form. It wraps the I-9 Complete signer lookup as a first-class workflow so parent workflows can delegate the question without duplicating I-9 search logic.

This workflow is category `Utils`. It has no dashboard input-run or upload-run start surface.

## Delegation Model

I9 Lookup is delegated-only. A parent workflow enqueues one person lookup with last name and first name; optional SSN can be included for disambiguation. I-9 Complete search is name-based, so this workflow must not be converted to UCPath EID input.

The workflow returns:

- `signerName` - the authorized representative who signed Section 2, or an empty string when there is no electronic signer.
- `i9Status` - `signed`, `unsigned`, `historical`, `not-found`, or `error`.
- `profileId` - the I-9 profile id when the lookup reaches a profile summary.

## Queue Behavior

| Scenario | Queue row | Title | Footer/subtitle | Batch view | Actions |
|---|---|---|---|---|---|
| Delegated signer lookup | One person row, grouped as a delegated batch surface even when one row exists. | Person name. | Normal delegated child footer. | Appears in the Utils/I9 Lookup workflow context. | Cancel/retry/delete one lookup row. |

The runtime policy sets `memberRow.titleSource: "person"` and `delegation.alwaysBatchDelegatedMembers: true`, matching the delegated utility grouping used by Person Lookup.
