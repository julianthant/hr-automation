# Workflows

Every workflow is kernel-based. Declare shape via `defineWorkflow` in `workflow.ts`; run through `runWorkflow`, `runWorkflowBatch`, or `runWorkflowPool` from `src/core/`.

## New Workflow Rules

- `defineWorkflow` owns `name`, `label`, `archetype`, `inputSubject`, `code`, `category`, `runtimePolicy`, `systems`, `steps`, `schema`, `tiling`, `detailFields`, display-name/id helpers, operator subject, and handler. `queueRowKind` is derived from `inputSubject`, not declared directly.
- The kernel owns browser launch, Duo-aware auth, tracker emissions, screenshots on step failure, SIGINT cleanup, batch/pool wrapping, and dashboard registry data.
- Do not add Commander subcommands or package scripts for operator starts. Public starts are dashboard input/upload runs.
- Do not create workflow-local `tracker.ts`; kernel JSONL emissions + dashboard are the observability surface. The only grandfathered workflow tracker is `old-kronos-reports/tracker.ts`.

## Kernel Contracts

- `ctx.page(id)` returns a Playwright Page proxy that injects per-run `ctx.signal` into Playwright methods with `signal?: AbortSignal`. Do not add handler-side cancel polling for ordinary browser calls.
- For non-Playwright awaits that accept an `AbortSignal`, pass `ctx.signal`.
- Compose workflows with `ctx.delegateTo` and `ctx.delegateToAll`. Do not call `runWorkflow(child, ..., { parentRunId })` or `ensureDaemonsAndEnqueue(child, ..., { parentRunId })` directly inside handlers; architecture guards block this.
- Omitting `renderAs` is a delegated single row (the default — the legacy `renderAs:"flat"` hint was an identical no-op and was removed). `renderAs: "preview"` is a presentation hint; `renderAs: "batch"` means the parent represents a grouped person set, so children are stamped `batch-member` under the parent run (the only value that changes the derived archetype).

## Dashboard Integration

- Declare `label`, `getName`, `getId`, and labeled `detailFields` in `defineWorkflow`.
- Every `detailFields` key should be populated by `ctx.updateData`; a runtime `log.warn` fires if a declared field never appears.
- Input runs: add the workflow to `DASHBOARD_INPUT_RUN_WORKFLOWS`, configure `src/dashboard/lib/input-run-registry.ts`, and ensure `src/core/workflow-loaders.ts` resolves it for `/api/enqueue`.
- Upload runs: add the workflow to `DASHBOARD_UPLOAD_RUN_WORKFLOWS` and configure `src/dashboard/lib/run-modal-registry.ts`.
- Add a `:stop` script only for workflows with long-lived daemons.
- Workflow rail badges are backend-authoritative `wfCounts`. The active queue panel's top-level row count must not override the active workflow's rail count; resolved OCR prep rows that still render in the queue remain countable.

## Archetypes

Every workflow must declare `archetype` and `runtimePolicy`; architecture guards fail if either is missing. Spread `DEFAULT_WORKFLOW_RUNTIME_POLICY` unless the workflow needs delegation, preview, memberRow, or prepRow overrides.

- `single` — one person/subject, one row.
- `preview` — one review/approval row; OCR is the current preview workflow.
- `batch` — anchor row over multiple person/subject rows, or a parent that will fan out to person rows after approval.
- `operation` — a top-level coordinator row for an OCR-backed target workflow (oath-signature / emergency-contact), created at PDF upload in the target panel with the OCR run delegated under it. Display-only (no daemon task); stamped explicitly at `/api/ocr/prepare` as a direct `archetype: "operation"` literal on the row's `data` (not a named override param) — it is NOT a `WorkflowArchetype`, so `deriveRowArchetype` never produces it and no `defineWorkflow` declares it. Shows denormalized OCR status before approval, signer/contact member summary after. See `src/workflows/ocr/CLAUDE.md`.
- `parentRunId` means delegated scope only; it never changes stamped row shape.
- `batch-member` — one person/subject row that belongs to a grouped `batch` parent run.
- `operation-member` — the operation analogue of `batch-member`: one signer/contact row fanned out under an `operation` coordinator (parented to it). Stamped by the OCR approve fan-out via the `rowShape` runtime option when `isOperationCoordinatorWorkflow(operationWorkflow)`; like `batch-member` it is NOT a `WorkflowArchetype` (no `defineWorkflow` declares it) and projects to a `single` surface when rendered.
- Dispatch markers are `single` rows with `data.delegationRole = "dispatch"` for terminal-at-enqueue handoffs.

## Input subject + queue row kind + trace id

`archetype` (shape) is orthogonal to the subject axis. Every workflow declares `inputSubject` and `code`; the `queue-row-kind-coverage` architecture guard fails if either is missing. The presentation **kind** (`person|file|catalog`, stamped as `data.queueRowKind`) is **derived** from `inputSubject` — workflows no longer declare `queueRowKind` directly.

- `inputSubject`: what the workflow receives — `name | eid | email | kualiId | pdf | selector`, a literal or a resolver `(input) => subject` when it depends on the input variant (person-lookup: `emplId`→eid else name; crm-doc-download: `email`→email else eid). Assignments: name = separations/emergency-contact; eid = work-study/kronos/oath-signature; email = onboarding; kualiId = separations(docId)… (see each workflow); pdf = oath-upload/ocr; selector = sharepoint-download.
- **Derived kind** (`subjectToQueueRowKind` in `src/domain/queue-row-kind.ts`): `name|eid|email|kualiId → person`, `pdf → file`, `selector → catalog`. The kernel normalizer (`workflow.ts`) derives a `queueRowKind` resolver from `inputSubject`; the three stamping sites (`pending-data.ts`, `run-one-item.ts`, `run-workflow.ts`) are unchanged and still stamp `data.queueRowKind`.
- `code`: a 2-char per-workflow string used as the trace-id prefix (e.g. `ou`, `pl`, `os`). `data.__traceId` = `<code>-<…>-<runId4>` is **frozen once** at the first pre-emit and rides EVERY row for the run — re-emits read it back via `findFrozenTraceId`. `queueRowKind` likewise rides every row (seeded onto `stringifiedSeed` in `run-one-item.ts`), not just the pending pre-emit.
- Title/subtitle resolve through `src/domain/queue-row-presentation.ts` (dispatch on the stamped `data.queueRowKind`) — do **not** hardcode titles in the dashboard. No session-local ordinals in titles (`OATH 1`, `· #1234` are retired).

## Queue row status (statusExtensions)

A fourth, OPTIONAL axis, orthogonal to shape/kind/scope: **status**. When a workflow needs status beyond the 5 universal tracker statuses + the universal `cancelled` override, it declares `statusExtensions` on `defineWorkflow` (`src/domain/queue-row-status.ts`):

- `derivedStatus(entry)` → promote to a workflow-specific display status that replaces the badge (`notFound`, `needsReview`). person-lookup owns `notFound` (UCPath had no row; status still `done`); ocr owns `needsReview` (delegated awaiting-approval).
- `secondaryTag(entry, { isDone })` → a supplemental chip beside the badge (person-lookup's A/IA from `data.activeStatus`/`isActive`).

Rule objects live client-bundle-safe in domain/tracker (`domain/person-lookup-status.ts`, `tracker/dashboard/ocr-status.ts`) and are re-exported as the workflow's `statusExtensions`. `statusExtensions` is optional — omit it and the row uses default base-status behavior. Do **not** branch on `entry.workflow` for status in the dashboard.

## Shared Ownership

Workflow-local functions describe orchestration steps. Reusable behavior belongs in `src/domain/`, `src/core/`, `src/services/ocr/forms/`, or the relevant `src/systems/` module. If another workflow could use it, promote it.

Internal helper workflow modules may live under `src/workflows/<name>/` without being operator-startable. Pure in-process helpers stay out of `WORKFLOW_LOADERS`; delegated-only daemon workflows belong in `WORKFLOW_LOADERS` so parents can enqueue them, but stay out of dashboard run-surface lists. `src/workflows/person-lookup/` is the operator-facing merged workflow (formerly EID Lookup + Active Check); it is registered in `WORKFLOW_LOADERS` and dashboard input runs, and also exports the `lookupPersonInUcpath` primitive for internal callers (OCR orchestrator, force-research, retry-page). `src/workflows/i9-lookup/` is delegated-only, registered in `WORKFLOW_LOADERS`, category `Utils`, and not in input/upload run surfaces.

## Opt-Ins

Daemon-capable workflow registration lives in `src/core/workflow-loaders.ts`. Do not convert in-process callers spawned from inside other workflow handlers.

The dashboard's "Edit Data" tab + kernel `prefilledData` channel lets an operator override extracted values and re-run without re-extracting. Only **separations** is opted in today. Do not opt in workflows whose inputs are already fully user-supplied.

## Lessons Learned

- **2026-05-30: Queue row status is a fourth (optional) axis via `statusExtensions`.** Per-workflow status rules (person-lookup A/IA + `notFound`, ocr `needsReview`) moved out of the generic `EntryItem` dashboard component into `WorkflowConfig.statusExtensions`, resolved by `resolveQueueRowStatus` (`src/domain/queue-row-status.ts`). Rule objects are client-bundle-safe (domain/tracker only — no `src/workflows/*` reaches the dashboard bundle) and registered for the client via `domain/queue-row-status-index.ts`. Optional axis: omitting it = default base-status behavior. No coverage guard (it's optional, unlike `queueRowKind`).
- **2026-06-02: Workflow rail badge counts are backend-authoritative.** `wfCounts` are computed by backend queue/sidebar row counting and passed through `buildWorkflowRailEntryCounts`; the active queue panel no longer overrides the active workflow badge with its scoped top-level count. Resolved OCR prep rows that still render in queue surfaces stay included in counts, and retired workflow ids are filtered before the rail sees them.
- **2026-06-01: `inputSubject` is the declared subject axis; `queueRowKind` is derived from it.** Workflows declare `inputSubject` (`name|eid|email|kualiId|pdf|selector`) on `defineWorkflow` — a literal, or a resolver for input-variant workflows. The presentation `queueRowKind` (`person|file|catalog`, still stamped as `data.queueRowKind`) is derived via `subjectToQueueRowKind` in the kernel normalizer (`src/core/kernel/workflow.ts`), so the stamping sites and the dashboard are unchanged. `queueRowKind` is **no longer a `defineWorkflow` field** — the `queue-row-kind-coverage` guard now asserts `inputSubject`. Many subjects funnel onto three kinds (every person-identifying subject → person); this keeps the presentation taxonomy small while naming each workflow's input precisely. person-lookup is the remaining multi-shape workflow; it discriminates by **field presence** (`z.union` + a type guard), not a `kind` literal. (oath-signature was multi-shape too; its PDF variant was removed 2026-06-02 — it's now EID-only, and the paper-roster flow is owned by OCR's approve fan-out.)
- **2026-05-30: Queue row kind is a third axis, orthogonal to shape and scope.** Kind drives title/subtitle only (via `src/domain/queue-row-presentation.ts`) — never footer/layout/status. Pending→resolved phase is derived at projection time from data presence, not stamped. Trace id (`data.__traceId`) replaced session-local ordinals in titles; `code` is its 2-char prefix. (Superseded declaration mechanism: kind is now derived from `inputSubject` — see the 2026-06-01 entry above.)
- **2026-05-28: Person Lookup is the merged operator-facing workflow (formerly EID Lookup + Active Check).** `src/workflows/person-lookup/` is registered in `WORKFLOW_LOADERS` and dashboard input runs. It also exports the `lookupPersonInUcpath` primitive for internal callers. Do not add separate `eid-lookup` or `active-check` entries back to any registry.
- **2026-05-28: Row archetype follows person/subject cardinality, not process count.** A one-person run is `single`; a grouped input run or a PDF/upload path that fans out to people is `batch` with `batch-member` children. Do not collapse an OCR/PDF fan-out to `single` just because it produced one approved person.
- **2026-05-25: Dashboard run surfaces are the public start paths.** New operator starts must be input runs or upload runs. Do not add `npm run <workflow>` launch scripts or YAML/batch-file starts; keep CLI adapters internal when tests or composed workflows still need them.
- **2026-05-16: `buildCliAdapter` remains the internal daemon adapter pattern.** Use it for "shape inputs → enqueue typed items → pre-emit pending rows"; keep pending-data helpers small when reused by in-process paths.
- **`ensurePageHealthy` is gone.** Use `ctx.session.healthCheck(id)` for an explicit mid-handler probe if needed.
