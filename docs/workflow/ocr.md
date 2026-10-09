# OCR Workflow

## What It Does

OCR turns uploaded PDFs into operator-approved structured records. It loads any needed roster data, renders and OCRs the PDF (including matching and disambiguating as sub-phases of the `ocr` step), runs person-lookup enrichment, then pauses for operator approval. Approved records fan out into the target workflow: Oath Signature, Emergency Contact, or OnBase Import. A standalone OCR run (no `parentRunId`) completes `done` after `person-lookup` — it has no downstream consumer so it does not pause for approval.

OCR is the only `preview` row archetype so far. It is not a batch row.

Form types registered in `FORM_SPECS` (`src/services/ocr/forms/registry.ts`): `oath`, `emergency-contact`, `onbase-emergency-contact`, and `verify`. The `verify` type is read-only (no approve fan-out).

## Delegation Model

```mermaid
flowchart LR
  A["loading-roster"] --> B["ocr<br/>{ render + OCR + match + disambiguate }"]
  B --> C["person-lookup<br/>{ resolves EID + active status }"]
  C --> D["awaiting-approval<br/>{ operator approves/discards }"]
  D --> E["target workflow fan-out<br/>{ oath-signature, emergency-contact, or onbase }"]
```

A standalone run (no `parentRunId`) completes terminal `done` at `person-lookup` — the `awaiting-approval` step and fan-out are skipped.

OCR utility Person Lookup children use delegated-batch grouping:

- One OCR person needing Person Lookup is a one-member batch surface in the Person Lookup tab.
- Multiple OCR people needing Person Lookup under the same OCR parent form the same kind of batch surface.

## Queue Behavior

| Scenario | Row type | Title | Footer/subtitle | Batch view | Actions |
|---|---|---|---|---|---|
| One PDF OCR preview | Approval delegation row; log label should be `Single delegation · Preview`. | PDF name. | Form-specific default title when present, otherwise normal footer id. | OCR preview/records for that file. | Cancel/discard, retry preview, delete preview, retry page, re-OCR whole PDF, force research, approve selected records. |
| Multiple PDFs OCR preview | Batch delegation row over multiple single-file preview rows. | Batch/default title. | No raw parent run id in group footer. | Preview rows, one per PDF. | Retry/delete group members; cancel per file through member row. |
| Roster download needed | Delegated SharePoint Download utility child under OCR. | Roster/download label. | Normal child footer. | Utility member row. | Cancel/retry utility child only. |
| Person lookup needed | Delegated batch surface, even when there is only one lookup. | Person/EID. | Normal child footer. | Member rows in the Person Lookup workflow context. | Cancel/retry one lookup only. |
| OCR approved | Preview row becomes done/approved; selected records fan out. | PDF name. | Same preview footer. | Target workflow children appear as members. | Retry target children individually; retry preview only if the preview row is retried. |
| OCR discarded | Preview row is hidden from normal queue surfaces after discarded filtering. | PDF name in logs/history. | Same preview footer. | Delegated children for that OCR run are deleted. | Discard is file-scope cancellation. |
