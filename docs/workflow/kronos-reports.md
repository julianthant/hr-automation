# Kronos Reports Workflow

## What It Does

Kronos Reports generates or retrieves Kronos report data for one or more report targets.

## Delegation Model

Kronos Reports does not delegate to another workflow. It is batch-capable when its runner launches multiple report targets.

## Queue Behavior

| Source | Queue row | Title | Footer/subtitle | Batch view | Actions |
|---|---|---|---|---|---|
| Workflow-specific runner; not currently in input-run or upload-run registries. | Normal/batch rows when launched by its own path. | Name/id subject. | Normal footer. | Member rows for each report target when batched. | Cancel/retry/delete per row if surfaced through normal task/tracker paths. |
