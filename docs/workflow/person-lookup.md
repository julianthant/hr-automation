# Person Lookup Workflow

## What It Does

Person Lookup resolves an employee by name or EID in UCPath Person Org Summary, cross-verifies name searches against CRM when needed, and derives active / HDH status. It replaces the retired EID Lookup and Active Check dashboard workflows.

## Delegation Model

Person Lookup does not delegate to another workflow. OCR can delegate to Person Lookup when extracted records need employee lookup or active-status verification.

When OCR creates Person Lookup children:

- One OCR person creates one single Person Lookup row.
- Multiple OCR people with the same OCR parent form a batch surface.
- Each lookup row remains independently cancellable/retryable.

## Queue Behavior

| Scenario | Row type | Title | Footer/subtitle | Batch view | Actions |
|---|---|---|---|---|---|
| Dashboard input run | Normal daemon row. | Person name or EID. | Normal footer and resolved EID when available. | No, unless multiple inputs share a batch context. | Cancel/retry/delete one lookup row. |
| OCR utility child | Single delegated row, or batch surface when multiple siblings exist. | Person/EID, preferring resolved person/EID over technical OCR retry ids. | Normal child footer. | Appears in the Person Lookup workflow tab. | Cancel/retry affects only that lookup/person. |

Retired `eid-lookup` and `active-check` tracker history remains on disk for audit purposes, but those workflow ids are filtered out of dashboard workflow lists and rail counts.
