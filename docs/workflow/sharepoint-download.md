# SharePoint Download Workflow

## What It Does

SharePoint Download retrieves files or roster data from SharePoint. OCR can use it as a utility child when roster data is needed before matching and approval.

## Delegation Model

SharePoint Download does not delegate to another workflow. OCR can delegate roster download work to it, and that child remains scoped to the OCR preview run.

## Queue Behavior

| Source | Queue row | Title | Footer/subtitle | Batch view | Cancel/retry |
|---|---|---|---|---|---|
| Direct SharePoint download UI/API | Normal utility/in-process row. | Download label/filename/path. | Normal footer. | None unless grouped by caller. | Retry uses SharePoint special handler/spec id. |
| OCR roster download | Delegated utility child under OCR preview. | Roster/download label. | Normal child footer. | Appears as utility member under OCR preview. | Cancel/retry affects only the roster download child. |
