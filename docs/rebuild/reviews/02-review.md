# Adversarial review — 02-workflow-model.md (2026-07-17)

Verdict: **buildable with amendments** — direction sound, but docs 01/02 describe two different
systems at the seam, plus two correctness holes. Resolutions: `../04-reconciliation.md`
(D1–D3, D6–D9, D16).

1. **BLOCKER — 01/02 incompatible on task identity, contract location, shape.** Slash vs dot ids;
   doc 02's separate `temp_src/contracts/**` tree (with mandatory `example`) vs doc 01's "store is
   the ONLY registry" with no example; 02's own guard forbids descriptors importing its contracts
   tree; 01's "descriptor projects from the task def" pulls Playwright into the bundle. Today's
   crossing works because rule objects live in `src/domain` (`queue-row-status-index.ts:19-27`).
   → D2 (slash grammar), D3 (contract/impl split under `temp_src/domain/contracts/`).
2. **BLOCKER — Checkpoint replay pushes stale reads into live writes.** Separations: attempt 1
   checkpoints `ucpath-job-summary` (`src/workflows/separations/workflow.ts:820`); next-day retry
   at `kronos-search` replays it and proceeds automatically into the `ucpath-transaction` write
   (`:1114`) with yesterday's data. §3.6's gate fires only when startAt lands ON a write task. No
   age/TTL, no pre-write freshness. Charter-banned silent substitution. → D8 (capturedAt +
   mandatory freshness.maxAgeMs + bind-graph walk + loud refusal).
3. **BLOCKER — "Logical item" + linear task chain don't exist for half the system.** Operation
   coordinators and i9 display-only members have no daemon task; OCR per-page pool/re-OCR/verify
   relookup is not a static task list; `tasks.id` is TEXT not INTEGER; real key is
   `(workflow, item_id)` (`src/tracker/state/schema.ts:191,243,267`). → D9 (explicit scope +
   schema fixes).
4. **MAJOR — dryRun contradiction** (01: envelope; 02 table: input). → D6 (envelope).
5. **MAJOR — write-ness declared twice** (`TaskStep.write` vs contract `effect`), no guard ties
   them. → D7 (derive from effect; delete step flag).
6. **MAJOR — Three label sources** (contract title, step label "ONLY place", presentation
   overrides + surviving endpoint layering). → D16 (two layers, precedence stated once).
7. **MAJOR — Two different builder APIs** (01 §5 `.step/.decorate/.instrument` + auth override vs
   02 §3.2 `.task({uses,bind,when,replay,write})` with no decoration slot). → D1: doc 02 owns ONE
   builder API and must include doc 01's decoration/instrumentation attachment points.
8. **MAJOR — Same task, two contracts across docs** (`search-person-org` I/O shapes differ).
   → D16: defined once in doc 01 §9; doc 02 imports it.
9. **MAJOR — Unstated assumption: every task self-navigates from a cold page.** Wizard legs
   (separations Smart HR fill+submit `workflow.ts:1114`, Kuali finalization `:1153`) are
   page-state-coupled. → Amendment: state the authoring rule — a task owns its navigation from any
   fresh page; wizard legs are atomic single tasks; resume grain = task boundaries only.
10. **MINOR — Attempt semantics ambiguous** (in-run retries vs cross-resume attempt vs legacy `-N`
    display suffix). → D10 (attempt-suffixed spans in-run; retryOf across runs; `-N` display-only).
11. **MINOR — `descriptor.systems` is a hand list** doc 01 bans; SystemId naming vs real dirs
    (`new-kronos`/`old-kronos`). → D2/D15: derive session union from task contracts; real dir names.
12. **MINOR — Example-derived stubs can't express failure/cancel/parallel scenarios.** → D3:
    examples drive happy path only; scenarios stay hand-scripted.

Verified sound: trace-id extension is byte-compatible (span suffixes live in spanId; frozen-once +
`tracePrefix`/`rootTracePrefix` propagation in `src/core/delegate.ts:229-350` untouched);
`step_change` deletion is covered by doc 03's timeline/LogStream migration (consumers:
`src/tracker/state/queries/{runs,entries-payload}.ts`, `StepPipeline.tsx:340`, `LogLine.tsx:120`).
