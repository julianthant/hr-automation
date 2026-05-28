# CRM Doc Download Workflow

## What It Does

CRM Doc Download retrieves documents from CRM for a person or document identifier. It is a utility workflow and can be launched from typed input or the daemon loader.

## Delegation Model

CRM Doc Download does not delegate to another workflow. Multiple inputs can group as a daemon batch, but each document download remains its own work item.

## Queue Behavior

| Source | Queue row | Title | Footer/subtitle | Stages | Cancel/retry |
|---|---|---|---|---|---|
| Input run or daemon loader | Normal utility row; multiple inputs can group as daemon batch. | Email, EID, or person name. | Normal footer. | CRM document download steps from workflow metadata. | Cancel/retry affects one download row; group retry/delete acts on visible members. |
