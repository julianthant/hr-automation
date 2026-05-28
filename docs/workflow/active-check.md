# Active Check Workflow

## What It Does

Active Check verifies whether an employee is active in UCPath. It is a utility workflow used directly or as part of OCR verification.

Stage: active-status verification in UCPath.

## Delegation Model

Active Check does not delegate to another workflow. OCR can delegate to Active Check when extracted records need active-status verification.

One OCR-created Active Check is a single row. Multiple Active Check siblings under the same OCR parent can group as a batch surface.

## Queue Behavior

| Source | Queue row | Title | Footer/subtitle | Batch view | Cancel/retry |
|---|---|---|---|---|---|
| Direct input run | Normal row. | Name/EID/search input. | Normal footer. | None unless multi-input batch. | Cancel/retry affects only that check. |
| OCR utility child | Delegation member row; grouped as batch when multiple siblings exist. | Person/EID. | Normal child footer. | Appears inside OCR context and in the Active Check workflow tab. | Cancel/retry affects only that check/person. |
