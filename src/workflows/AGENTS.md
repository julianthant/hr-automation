# Workflows

Workflow folders own orchestration: schema, step composition, CLI adapter, and workflow-specific business decisions. Reusable domain, system, OCR form, notification, logging, and control behavior belongs outside `src/workflows/<workflow>/`.

## Shared fixes before workflow-local helpers

Before adding a helper in a workflow folder, check whether the same behavior already exists in:
- `src/domain/identity/`
- `src/domain/operator-subject.ts`
- `src/domain/log-events.ts`
- `src/domain/notifications/`
- `src/core/task-display.ts`
- `src/core/task-control.ts`
- `src/services/ocr/forms/`
- `src/systems/ucpath/person-org-summary.ts`
- `src/domain/hdh/departments.ts`

If the helper would be useful to another workflow, add or extend the shared module instead. Keep compatibility exports only as migration shims.

## Naming and ownership conventions

Workflow-local functions should describe orchestration steps. Reusable behavior must move to `src/domain/`, `src/systems/`, `src/core/`, or `src/services/ocr/forms/`. Use the naming verbs in `docs/engineering/codebase-conventions.md`; avoid vague helpers like `processData` or `handleThing`.
