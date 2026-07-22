# Rebuild Program Charter — `temp_src`

Started 2026-07-17. Reset 2026-07-21 after external review. Expanded 2026-07-22 after the
whole-plan/legacy-code review. Status: **Phase 0 — revised foundation design; no rebuild
implementation exists**.
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
   Every *system* has a store—`ucpath`, `onbase`, `crm`, `kuali`, `servicenow`, `i9`,
   `new-kronos`, `old-kronos`, `sharepoint`, plus the data-service systems (§11)—holding small, single-purpose,
   well-named tasks. AND every *workflow* has its own **mini-store** of tasks. **Any workflow may
   compose tasks from a system store, from its own mini-store, OR from another workflow's
   mini-store** — reuse is peer-to-peer, not only workflow→system. A task promoted because a second
   workflow needs it simply gets imported from wherever it lives; there is no forced relocation.
   Workflow mini-stores contain pure workflow-specific compute only (`sessions:[]`, `effect:"read"`);
   anything that opens a browser or prepares/commits an external write lives in the owning system
   store. Peer reuse therefore cannot bypass system session or write-safety policy.
   Tasks stay specific: one function does one specific thing (a "fill form X" task is distinct from
   a "submit form X" task — see §a). When something breaks, the broken task is identifiable by name
   from the trace alone. Store location never implies scheduling semantics: the workflow graph owns
   ordering, branching, fan-out, and page-scoped transaction composition.

   **§a — Fill and submit are always SEPARATE task contracts inside one page-scoped transaction
   node (dry-run mechanism, revised 2026-07-21).** A fill task has `effect:"prepare"`: it may mutate
   the browser page but not the external HR system. A submit/save/upload task has `effect:"commit"`
   and is the only task allowed to cross the external-write boundary. The graph pairs them in a
   `transaction` node. Both execute under one uninterrupted page/context lease because staged wizard
   state is not serializable and lease cleanup would destroy it. A real run binds a stable commit
   input, resolves durable history and any live idempotency probe on a separate read lease, then
   executes `prepare → fresh subject bind → fence → commit → verify` on the uninterrupted
   transaction lease. The probe
   is never allowed to navigate the staged page. A dry run executes the same prepare task and
   structurally omits the commit arm before execution. The prepare and commit remain separately
   named task spans, but there is no checkpoint, retry, park, or page reset between them. A crash
   after the fence is write recovery, never "resume at submit."
2. **Typed task contract** — every task declares zod input + output schemas; TS types are inferred
   from them. Types are the primary hardening mechanism: a contract change on one side must **fail
   to compile** on the other. No ambiguity, no stringly-typed dispatch.
3. **Base task + customization** — workflows compose base tasks from the stores and decorate them
   (extra actions, screenshots, checks) without forking the base. Adding a task to a workflow must
   not break the workflow. Instrumentation (screenshots etc.) attachable at any point.
4. **Workflow-constant input** — each workflow declares its own zod input schema; that input is
   fixed for the entire run. Enables rerun with different inputs and **start from any resumable graph
   node**—never an internal prepare/commit arm. Entry validation fails loudly if required upstream
   outputs/provenance are missing and proceeds only when the full node-entry contract is satisfied. The
   task-N-consumes-task-N-1-output tension must be resolved by an explicit, validated mechanism
   (design doc 02 owns this).
5. **Descriptor SSOT** — a bundle-safe, plain-data descriptor per workflow containing its complete
   typed graph (task, transaction, branch, parallel/fork-join, child-run, and gate nodes), versioned
   identity, presentation, run surfaces/actions, input presets, item identity, completion program,
   subscriptions, and coordinator policy. Server runtime and client metadata are projections of
   this descriptor; the browser consumes a generated/client-safe projection rather than importing
   workflow modules. Playwright implementations stay behind the server registry. Every current
   parallel list must either disappear into a projection or be named explicitly as a deliberate
   non-workflow registry.
6. **Trace + timeline SSOT** — a well-defined trace id with run/task spans and span-addressed action
   notes covering every action. Timelines, step durations, and step labels are computed **from**
   spans + the descriptor; action detail joins by span path. There is no second hand-maintained
   source of time or naming anywhere.
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
   `normalization` (contact/address rules plus explicit provider-backed suggestions), `ocr`, and
   `roster` (spreadsheet matching) are their own systems with their own task stores. Remote
   OCR/model/geocoder calls are declared provider capabilities with injected clients, bounded
   admission, redaction, and typed failure outcomes; a service task cannot hide network I/O in a
   direct SDK import.
   Extraction and roster use **operator-defined column mapping**: the operator manually connects a
   source column title to a canonical codebase field (e.g. some spreadsheet's column → `eid`); the
   mapped values flow into the workflow's zod input schema, so every cell and assembled row is
   schema-validated with visible row-level rejection—not guessed into validity. Design doc: `06-data-intake-and-edit-data.md`.
12. **Edit Data over checkpoints (operator directive 2026-07-17).** Whenever a run is stopped or
   parked for later resume, the data the workflow currently holds (its checkpoint state) is ALWAYS
   live-visible in the Edit Data tab. Descriptor-allowlisted correction fields are editable and
   schema-validated on save; identity, input, idempotency, proof, and provenance are read-only.
13. **Write-safety — fenced, fail-closed real mutations (gap audit `08` + operator answers 2026-07-18;
   full design: doc `09`).** Every mutation gets completion-verification and double-submit
   protection appropriate to its system, and completion is checked **FAIL-CLOSED**: an unknown or
   unverifiable result is NEVER treated as done (operator: *"you have to be very sure they were
   completed"*). Per system:
   - **UCPath / CRM / ServiceNow** — the irreversible submits. The submit task captures a
     **verifiable receipt** (e.g. a confirmation number) as its typed output; the kernel runs a
     resolve/probe → prepare → binding proof → fence → external-commit → proof → durable-commit
     sequence, and crash-recovery re-runs the probe. A post-fence `absent` authorizes retry only
     after the contract's typed, system-specific propagation/negative-proof policy succeeds; a
     single early miss parks as unknown.
     UCPath is where the real incidents happened (a duplicate person; a wrong-person termination,
     `T002173685`). Permanent-key fencing closes double filing; the wrong-person class additionally
     requires the designed identity-approval gate before separations. The plan never claims a probe
     that can read the wrong person makes that class structurally impossible.
   - **Kuali** — **SAVE-only, not a submit** (operator 2026-07-18): a write, but not an irreversible
     filing. No confirmation-number receipt needed; the automation must still verify the save
     completed, fail-closed.
   - **OnBase** — the operator **tracks completion manually** (operator 2026-07-18). The automation
     must be *very sure* the upload completed before it reports done — fail-closed, never fail-open.
   - An **immutable write-proof ledger** records what was actually filed/saved and is **never
     pruned**. SQLite is the transactional authority: committing a write atomically records the
     checkpoint plus ledger/span outbox rows. A serialized projector assigns hash-chain sequence
     numbers and appends JSONL; recovery reconciles every committed-intent/outbox/span permutation.
   - The per-submit **double-submit probe policy is decided per-workflow at migration time**
     (operator deferred it), via the §b migration questionnaire.
   - A parked write has no generic Done/Retry escape hatch. The operator may attach proof that parses
     through the commit arm's proof schema (which performs the same atomic durable commit), or record
     an audited confirmed-absent decision that makes the permanent intent retryable. An
     `unverifiableByPage` write uses a typed operator-attestation proof; it never turns an uncertain
     page result into automatic success.
   - **Guarantee boundary (D64):** the kernel guarantees at most one unattended commit attempt per
     permanent intent generation and never retries from an unproven absence. Automatic recovery
     converges when the target supplies valid positive or stabilized negative evidence; targets
     without an idempotent API or authoritative negative read park for operator resolution. The
     plan does not claim unconditional distributed exactly-once from a UI probe.

14. **Local artifacts are replay-safe, not hidden writes.** A `read` task may download or derive a
   content-addressed local artifact only through the kernel artifact writer (temp + fsync + atomic
   rename); retries address the same bytes and cannot append mutable business state. Mutable local
   outputs such as i9's retention workbook are projections of stable-keyed SQLite outboxes, written
   by a serialized projector. They are not mislabeled read-task side effects and cannot duplicate on
   task retry.

15. **Runtime-validated data, not TypeScript-only confidence.** Every value crossing an external,
    persistence, command, event, config, or client boundary is parsed by a strict zod schema.
    Branded ids/scalars and discriminated outcomes replace interchangeable strings; `optional`
    means not supplied, `nullable` means observed no value, and `unknown` is an explicit outcome
    that must be handled. Open `Record<string, unknown|JsonValue>` bags are forbidden for durable or
    decision-driving data. Full rules: docs 01/03 and reconciliation D46.
16. **Observed-subject binding before real writes.** The intended EID/name in a workflow input does
    not prove which person's page is open. Subject-scoped browser tasks may declare an authoritative
    UI observation and matching policy for high-risk reads; every prepare/commit pair must. A commit re-observes and matches the page
    after prepare, immediately before the fence/click, and records expected+observed proof in the
    transaction evidence. Missing/mismatched identity fails or parks before mutation. This closes
    the stale-page class seen in New Kronos and complements—does not replace—the separations
    identity-approval gate. Full enforcement: docs 01/09/12.
17. **Queue/control/delegation are kernel protocols, not workflow features.** Enqueue, retry,
    cancel, bump, hide/restore, authoritative tree targeting, dependency transitions, and command
    idempotency/versioning have one server-owned implementation. “Delete” means reversible
    **Hide from queue**; destructive Purge is a separate offline maintenance operation. Workflows
    can restrict safe actions, never redefine their semantics. Delegation declares typed child
    input/output, stable child identity, join/failure/partial/cascade/retry policy, and is persisted
    atomically with the child manifest. Full design: docs 02/03.
18. **Semantic UI vocabulary + trustworthy evidence.** Important controls, screens, page states,
    and observations have stable canonical names with aliases and verification evidence. Browser
    tasks use typed system drivers; raw Playwright pages/locators stay inside driver/session
    infrastructure. Every run projects a receipt of inputs, observations, decisions, actions,
    verification, output, reused checkpoints/proofs, warnings, and uncertainty. Failures produce a
    structured record and redacted diagnostic bundle addressable by `explain run`. Full design:
    doc 12.
19. **Scenarios and knowledge improve with real use without becoming a pile.** Every task/workflow
    has a registered scenario corpus beyond one happy example; unexpected page states fail visibly
    and become new scenarios when understood. Existing LESSONS are triaged, not copied wholesale,
    into structured active/superseded/retired knowledge. AI-assisted fixes record the failure,
    affected ids/files, regression scenario, verification, and commit; raw chat is never authority.
    Full design: doc 12.
20. **The workflow editor starts as the real graph, then earns safe editing.** The Phase-1 base
    includes a read-only descriptor/live-run explorer. After Phase 2 it may edit presentation and a
    closed set of typed composition/policy fields through compile/validate/diff/version/apply;
    arbitrary code, selectors, subject matchers, idempotency keys, and write proof remain code work.
    Running runs never hot-change. Full design: doc 12.
21. **Irreplaceable local state has an operational recovery contract.** SQLite claims,
    checkpoints, dependencies, commands, intents, manifests, and outboxes are not reconstructible
    from JSONL. Startup integrity/migration/disk/WAL checks, rotating online backups, mandatory
    pre-migration backup, restore drills, and read-only rescue mode are part of the base. New writes
    stay disabled when authority health is unknown. Full storage owner: doc 03.
22. **Mobile photo capture is reliable intake, not an in-memory sidecar.** Open sessions, token
    expiry, ordered photo digests, finalization, and OCR/intake handoff survive dashboard restarts.
    Finalization is one durable, retryable operation: bundle/register/enqueue succeeds visibly or
    fails visibly; it cannot return success and lose a background callback. The main app remains
    loopback-only; an operator-started short-lived phone tunnel exposes only token-scoped capture
    endpoints. Full intake design: doc 06; network boundary: doc 12.
23. **AI assistance is optional evidence, never authority.** OCR/contact normalization and
    operator-requested triage, sanity checks, selector suggestions, or run summaries return strict,
    provenance-labelled advisory outcomes. Redacted inputs only; unavailable/invalid model output
    is distinguishable from “nothing wrong.” AI cannot select a person, resolve a gate, alter run
    state, declare success, create a selector, or authorize a commit. Deterministic contracts,
    scenarios, receipts, and UI registry remain authoritative.
24. **The old code is retired by capability inventory, not workflow count.** Every old workflow,
    service, route family, dashboard surface, CLI/ops command, exporter, code generator, and
    maintenance tool receives a port/replace/retire/proxy disposition plus a closing milestone.
    `src` cannot be deleted while any inventory entry is undecided or still proxied. Master owner:
    doc 07; guard owner: doc 10.

## Non-negotiables

- **Fail loud.** The root `CLAUDE.md` rule applies in full to `temp_src` from the first line.
- **Port, don't rewrite, live-verified leaf knowledge.** Selectors (`// verified` dates),
  `duo-login-flows.ts`, UCPath iframe/modal-mask handling, OCR fabrication-tiering + tolerant-field
  lessons, OnBase single-session constraint. This code moves nearly verbatim and gets *wrapped* in
  new contracts. Re-derivation from scratch is forbidden — it discards live verification.
- **Port knowledge, not stale lesson files.** Existing `LESSONS.md`/`CLAUDE.md` entries are evidence
  for migration. They are triaged into doc 12's structured active knowledge or incident history;
  superseded/incorrect/duplicate guidance does not move into the rebuilt prompt/search surface.
- **Local-only is a scope reduction, not a correctness waiver.** No RBAC, multi-tenant service,
  remote operator deployment, distributed consensus, or high-availability work is required. The
  operator server stays localhost-only; doc 06's short-lived token-scoped mobile-capture ingress is
  the sole explicit exception. Secret/SSN/HR-data redaction, reliable backups, strict validation,
  and fail-closed write/identity behavior remain mandatory because the tool handles real employee
  data and transactions.
- **Same quality umbrella from day one.** `temp_src` is inside the same tsconfig project, unit
  tests, and `npm run test:architecture` ratchets (extended to cover it). No ungated parallel tree.
- **No implementation before the corrected dependency graph is accepted.** The abandoned Phase-1a
  skeleton and spike were removed on 2026-07-21. The next implementation starts from an empty
  `temp_src`; no type shell may forward-declare a contract owned by a later phase.
- **Old system keeps working throughout.** Every dual-maintenance window is explicit and ends when
  that system's final consumer migrates. Single-consumer systems should be short; shared UCPath/CRM
  windows are honestly program-length. When a system is fully migrated, the old `src` copy is deleted.

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
- **Phase 1:** pre-tree guard plumbing, then the first domain leaf plus type/lint/guard activation in
  one commit; after that: strict config/domain primitives → authority storage/recovery + command/
  write-safety shells → semantic UI registry/drivers + task/store/session contracts → complete
  workflow graph/results/delegation/scenarios → executor/checkpoints/control/write sequencer →
  spans/projections/evidence/diagnostics/notifications/knowledge → data services, durable capture,
  typed intake, optional advisory AI, and dashboard/read-only workflow explorer → full restore/
  soak/capability-inventory/doc gate. The core registry is the composition root; lower
  layers never import workflows.
- **Phase 2:** two vertical proofs before volume migration: person-lookup end-to-end proves the read
  path; a page-scoped transactional workflow/harness proves prepare-only dry-run, real commit
  recovery, durable dedupe, and ledger projection. A read-only slice cannot prove write safety.
- **Phase 3+:** per-workflow migration, one at a time, slowly populating the task stores with what
  each workflow needs. Every workflow gets its own migration plan doc answering: which store tasks
  it reuses, which new tasks it needs, how each new task is designed as a reusable base + what the
  workflow-specific customization is, and how deep reuse goes beyond the surface.
  - **§b — Each migration includes an operator decision checkpoint (operator directive
    2026-07-18).** Before a workflow is built on the new base, the orchestrator asks the operator
    the workflow-specific questions so nothing is missed for that workflow: which actions are real
    submits, the receipt source + completion check per submit, the double-submit probe policy, the
    dry-run boundary (which submit tasks to split), and any workflow-specific data/gate quirks. The
    operator explicitly wants these questions asked at migration time — "cover everything for each
    workflow as we migrate." This questionnaire is part of every workflow's migration plan doc.
  - Cutover authority is stamped **per run** as `(engine, cutoverGeneration)` at enqueue time. A
    legacy run may drain after the workflow accepts native runs without having its terminal updates
    quarantined. A workflow-wide timestamp is not a source-authority rule.

## Process

- Work stays sequential by default with coherent local commits and explicit handoffs when context
  separation is actually needed. The active implementer adversarially reviews every owning doc and
  the master-plan integration before presenting a phase as complete.
- Nothing in `temp_src` gets built before its design part is operator-approved.
