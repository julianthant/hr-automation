# EID Lookup Workflow

## What It Does

EID Lookup searches for and verifies employee identifiers from a name, partial record, or OCR-derived person record. It can run directly from typed input or as an OCR utility child.

Stages: `searching`, `cross-verification`, `active-status`.

## Delegation Model

EID Lookup does not delegate to another workflow. It is commonly delegated to by OCR as a utility child.

When OCR creates EID Lookup children:

- One OCR person creates one single EID Lookup row.
- Multiple OCR people under the same OCR parent create a batch surface.
- Cancel/retry applies to the selected lookup/person, not to the whole OCR run unless an OCR discard path is used.

## Queue Behavior

| Source | Queue row | Title | Footer/subtitle | Batch view | Cancel/retry |
|---|---|---|---|---|---|
| Direct input run | Normal utility row. | Search input, person, or EID. | Normal footer. | None unless launched as a multi-input daemon batch. | Cancel/retry affects only that lookup. |
| OCR utility child | Single delegated row when only one lookup exists. | Person/EID, preferring resolved person/EID over technical OCR retry ids. | Normal child footer. | Appears in the EID Lookup workflow tab. | Cancel/retry affects only that lookup/person. |
| Grouped utility children | Batch group when multiple lookup siblings share the same OCR parent. | Parent subject or utility title. | Group footer with no raw parent id. | Member rows for each lookup. | Group retry/delete acts on members. |
