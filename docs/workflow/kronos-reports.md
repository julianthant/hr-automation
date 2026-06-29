# Kronos Reports Workflow

## What It Does

Kronos Reports downloads Time Detail PDF reports from Old Kronos (UKG Workforce Central) for one or more employees. This is the legacy UKG system, distinct from the New Kronos used by the Separations workflow for timecard verification.

## Delegation Model

Kronos Reports does not delegate to another workflow. It is batch-capable when its runner launches multiple report targets.

## Queue Behavior

| Source | Queue row | Title | Footer/subtitle | Batch view | Actions |
|---|---|---|---|---|---|
| Workflow-specific runner; not currently in input-run or upload-run registries. | Normal/batch rows when launched by its own path. | Name/id subject. | Normal footer. | Member rows for each report target when batched. | Cancel/retry/delete per row if surfaced through normal task/tracker paths. |
