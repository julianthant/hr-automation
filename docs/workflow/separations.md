# Separations Workflow

## What It Does

Separations processes separation records across Kuali, Kronos, and UCPath. It extracts separation data, checks Kronos, verifies UCPath job summary data, performs the UCPath transaction, and finalizes the Kuali side.

## Delegation Model

Separations does not delegate to another workflow. It is batch-capable because multiple separation records can be launched together and shown as a daemon batch.

```mermaid
flowchart LR
  A["launching"] --> B["authenticating"]
  B --> C["kuali-extraction"]
  C --> D["kronos-search"]
  D --> E["ucpath-job-summary"]
  E --> F["ucpath-transaction"]
  F --> G["kuali-finalization"]
```

## Queue Behavior

| Source | Queue row | Title | Footer/subtitle | Batch view | Actions |
|---|---|---|---|---|---|
| Input run / daemon loader | Normal row per separation record; multiple records can show as daemon batch. | Person/name/doc/EID subject. | Normal footer. | Member rows for each separation record. | Cancel/retry/delete per row, group retry/delete, edit-and-resume via `/api/run-with-data` for editable fields. |
