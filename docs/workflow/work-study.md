# Work Study Workflow

## What It Does

Work Study performs a direct UCPath work-study transaction for one employee.

Stages: `ucpath-auth`, `transaction`.

## Delegation Model

Work Study does not delegate to another workflow. It is a single-row workflow unless launched by a caller that groups multiple work-study inputs.

## Queue Behavior

| Source | Queue row | Title | Footer/subtitle | Batch view | Actions |
|---|---|---|---|---|---|
| Daemon loader/API | Normal single row. | Person/name/EID subject. | Normal footer. | None unless launched in a parent batch. | Cancel/retry/delete per row. |
