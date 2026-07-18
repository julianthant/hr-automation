# Rebuild Program Charter — `temp_src`

Started 2026-07-17. Status: **Phase 0 — foundation design (brainstorm docs in this directory)**.
This is the single source of truth for the rebuild's vision and constraints. Every design doc in
`docs/rebuild/` must conform to it. The operator reviews each accepted part in plain language before
it becomes binding.

## Why we're rebuilding (evidence from the 2026-07-17 structural survey)

- **~10 parallel hand-maintained workflow registries** (`WORKFLOW_LOADERS`, dashboard run-surface
  lists, `INPUT_RUN_REGISTRY`/`RUN_MODAL_REGISTRY`, `INSTANCE_LABELS`, e2e stub map, icons, …).
  Adding/renaming a workflow means ~10 synchronized edits; only two lists have coverage guards; a
  typo compiles fine and fails at runtime.
- **Bundle-boundary fault line**: `defineWorkflow` never ships to the browser (workflows import
  Playwright code), so display metadata is re-declared client-side by hand — step-label string
  switches in `dashboard/components/shared/types.ts:406`, `workflow-icons.ts`, `INSTANCE_LABELS`.
  Rename a step and the UI silently renders stale text.
- **OCR approve contract divergence**: three shapes (`approveTo` per-record, `approveDocumentTo`
  per-document, `completeDelegatedRun` no-approval) branch inside one route, and
  `onbase-emergency-contact.ts:82` reaches into another spec's internals
  (`emergencyContactOcrFormSpec.approveTo!.canFanOut`) — cross-spec borrowing that drifts silently.
- **Per-workflow copy-paste**: ~15 lines of identical auth-deferral boilerplate in 5 workflows; the
  `operationTraceCode` switch (`workflows/ocr/orchestrator.ts:1562`) re-encoding codes that
  `defineWorkflow` already declares; status/icon/label maps re-declared in ~6 dashboard components.
- **Root cause**: the system is coupled **by convention** (independent lists sharing string names)
  instead of **by contract** (one typed thing both sides derive from). Nothing forces the second
  edit when you make the first.

## Target architecture (the operator's vision, formalized)

1. **Task stores — two levels (operator directive 2026-07-17, the core of the modular structure).**
   Every *system* has a store — `ucpath`, `onbase`, `crm`, `kuali`, `servicenow`, `i9`, `kronos`,
   `ukg`, `sharepoint`, plus the data-service systems (§11) — holding small, single-purpose,
   well-named tasks. AND every *workflow* has its own **mini-store** of tasks. **Any workflow may
   compose tasks from a system store, from its own mini-store, OR from another workflow's
   mini-store** — reuse is peer-to-peer, not only workflow→system. A task promoted because a second
   workflow needs it simply gets imported from wherever it lives; there is no forced relocation.
   Tasks stay specific: one function does one specific thing (a "fill form X" task is distinct from
   a "submit form X" task — see §a). When something breaks, the broken task is identifiable by name
   from the trace alone.

   **§a — Fill and submit are always SEPARATE tasks (dry-run mechanism, operator directive
   2026-07-17).** Any form interaction that ends in a real submission is authored as two tasks: a
   **fill** task (populates every field, `effect: "read"`-safe, no mutation) and a **submit** task
   (`effect: "mutate"`, the single click that files the transaction). A **dry run composes the flow
   WITHOUT the submit task** — the fill runs, the submit is simply absent, and the run reports
   "would have submitted X." This replaces any in-task `dryRun` runtime flag (which a skeptic proved
   bypassable): the dangerous action isn't skipped by a branch, it isn't in the composition at all.
   The operator curates which submits exist as their own task and will flag each one.
2. **Typed task contract** — every task declares zod input + output schemas; TS types are inferred
   from them. Types are the primary hardening mechanism: a contract change on one side must **fail
   to compile** on the other. No ambiguity, no stringly-typed dispatch.
3. **Base task + customization** — workflows compose base tasks from the stores and decorate them
   (extra actions, screenshots, checks) without forking the base. Adding a task to a workflow must
   not break the workflow. Instrumentation (screenshots etc.) attachable at any point.
4. **Workflow-constant input** — each workflow declares its own zod input schema; that input is
   fixed for the entire run. Enables: rerun with different inputs, and **start from any task** —
   entry validation errors loudly if required data is missing, works if it's right. The
   task-N-consumes-task-N-1-output tension must be resolved by an explicit, validated mechanism
   (design doc 02 owns this).
5. **Descriptor SSOT** — a bundle-safe, plain-data descriptor per workflow (id, code, label, icon,
   ordered tasks/steps with labels, run surfaces, contracts). Both daemon and client import it; the
   Playwright handler stays behind a lazy loader. Every current parallel list becomes a projection
   of the descriptor set, each with a coverage guard.
6. **Trace + timeline SSOT** — a well-defined trace id with run → task → action spans covering
   every action. Timelines, step durations, and step labels are computed **from** spans + the
   descriptor; no second hand-maintained source of time or naming anywhere.
7. **Tracker + dashboard in scope** — the event layer is rebuilt around span events; the dashboard
   consumes the descriptor + span contract. (Operator decision: full blast radius, including
   tracker.)
8. **Reusable by construction** — every task is designed plug-and-play even if only one workflow
   uses it today. Workflow-specific behavior lives in the customization layer, never inside a base
   task.
9. **Duo is fully automated, everywhere (operator directive 2026-07-17).** Duo Autopilot clears MFA
   hands-off for ALL runs — production operator runs included. The new design contains NO
   phone-approval pause, poll, or manual-MFA path anywhere. Session providers log in unattended.
10. **Parallelism-first kernel (operator directive 2026-07-17).** Today's parallel-worker model is
   slow (e.g. the ~33s UCPath sleep tax, serialized per-worker items). The new execution kernel is
   designed from the ground up for fast parallel work — same parallel-running capability as today,
   but re-architected for speed, not ported. Design doc: `05-execution-parallelism.md`.
11. **First-class data-service systems (operator directive 2026-07-17).** `extraction` (CSV + PDF),
   `ocr`, and `roster` (spreadsheet matching) are their own systems with their own task stores.
   Extraction and roster use **operator-defined column mapping**: the operator manually connects a
   source column title to a canonical codebase field (e.g. some spreadsheet's column → `eid`); the
   mapped values flow into the workflow's zod input schema, so ingest is schema-validated and
   error-free by construction. Design doc: `06-data-intake-and-edit-data.md`.
12. **Edit Data over checkpoints (operator directive 2026-07-17).** Whenever a run is stopped or
   parked for later resume, the data the workflow currently holds (its checkpoint state) is ALWAYS
   live-visible in the Edit Data tab and editable there — schema-validated on save — before the
   operator resumes. Editing checkpoint data is the supported way to correct a run's data mid-way.

## Non-negotiables

- **Fail loud.** The root `CLAUDE.md` rule applies in full to `temp_src` from the first line.
- **Port, don't rewrite, live-verified leaf knowledge.** Selectors (`// verified` dates),
  `duo-login-flows.ts`, UCPath iframe/modal-mask handling, OCR fabrication-tiering + tolerant-field
  lessons, OnBase single-session constraint. This code moves nearly verbatim and gets *wrapped* in
  new contracts. Re-derivation from scratch is forbidden — it discards live verification.
- **Same quality umbrella from day one.** `temp_src` is inside the same tsconfig project, unit
  tests, and `npm run test:architecture` ratchets (extended to cover it). No ungated parallel tree.
- **Old system keeps working throughout.** Per-system dual-maintenance windows are short and
  explicit; when a system's workflows are fully migrated, the old `src` copy is deleted, not kept.

## One master plan (operator directive 2026-07-17)

When the design docs converge, they are consolidated into a SINGLE phased master plan
(`07-master-plan.md`) containing every piece of information needed to build — there must never be
multiple competing plans that can cause mix-ups. Each concept has exactly one owning doc (the D1
matrix in `04-reconciliation.md`); the master plan sequences phases and references the owners, it
does not redefine contracts. **After each build phase completes, it is documented**: subsequent
phases add new docs and/or update existing ones so the documentation always matches what is built.
The foundation's documentation is part of the foundation.

## Migration strategy

- **Phase 0 (now):** foundation design docs in `docs/rebuild/`, each reviewed part-by-part with the
  operator in plain language (what the old version did → why it hurt → how the new design fixes it).
- **Phase 1:** minimal base in `temp_src` (task contract, descriptor, span/trace, event layer).
- **Phase 2:** vertical slice — one simple workflow (candidate: person-lookup) end-to-end on the
  new foundation, validated with a live dry-run, before any volume migration.
- **Phase 3+:** per-workflow migration, one at a time, slowly populating the task stores with what
  each workflow needs. Every workflow gets its own migration plan doc answering: which store tasks
  it reuses, which new tasks it needs, how each new task is designed as a reusable base + what the
  workflow-specific customization is, and how deep reuse goes beyond the surface.

## Process

- The orchestrator (main session) stays context-lean; deep design runs in subagents that write full
  docs here and return short summaries. The orchestrator adversarially reviews every doc before
  presenting it.
- Nothing in `temp_src` gets built before its design part is operator-approved.
