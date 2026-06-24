# Onboarding Workflow

## What It Does

Onboarding handles multi-system onboarding work across CRM, UCPath, and I-9 creation. It authenticates, extracts onboarding data, downloads PDFs, searches for the person in UCPath, creates I-9 work, and completes the transaction stage.

Stages: `crm-auth`, `extraction`, `pdf-download`, `ucpath-auth`, `person-search`, `i9-creation`, `transaction`.

## Delegation Model

Onboarding does not currently delegate to another workflow. It is batch-capable because multiple onboarding records can be launched together and shown as a daemon batch.

## Queue Behavior

| Source | Queue row | Title | Footer/subtitle | Batch view | Actions |
|---|---|---|---|---|---|
| Dashboard input run or daemon loader/API | Normal row per onboarding record; multiple records can show as daemon batch. | Email/person/input subject. | Normal footer. | Member rows for each onboarding record. | Cancel/retry/delete per row; group retry/delete for grouped members. |
