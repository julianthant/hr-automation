# Second-look review — whole program + legacy evidence (2026-07-22)

Reviewer: Claude (Fable 5), at operator request, after Codex's three passes (`e4e8d742`,
`9bc7f9fa`, `9026d9e7`). Method: six parallel audits — (1) design docs 01–06, (2) design docs
07–12 + reviews, (3) legacy typing/fallbacks/error-handling/logging, (4) legacy queue-row +
delegation bug archaeology, (5) legacy authoring cost + dashboard UI naming + workflow-modifier,
(6) lessons-system quantification. This file is the durable record; statistics cited below come
from those audits (file:line evidence preserved in the audit summaries).

**Status of this review: recommendations. Nothing here is binding until the operator accepts it
part-by-part per the charter process.**

---

## 1. Verdict on the current doc set

The design is **substantially right**. Three specific validations worth recording:

- **The queue/delegation design solves the actual recorded pain.** An independent bug-archaeology
  pass over the legacy tree (git log + lessons, no knowledge of docs 02/03) derived ten
  requirements a kernel-owned row/delegation protocol must satisfy. Docs 02/03 already contain
  nine of the ten: identity stamped once + immutable (patch with identity key throws at emit),
  first-class terminal statuses (no `failed+step:"cancelled"` encoding), single command protocol
  (D49/D67), one parent-link mechanism (child-run nodes + atomic manifests, D50), task-store
  terminal authority (exactly-once terminalization), counts derived from the same surface
  projection, kernel-only delegation API, supersede as an enqueue invariant, declarative
  rollup/cascade policy. The tenth is §3.4 below.
- **The typing design targets the real disease.** Legacy `any` is nearly extinct; the looseness
  lives in `Record<string, string>` row data (~164 undeclared keys, booleans as `"true"`,
  JSON-in-a-string double encoding, a `typedData` mirror bolted on) and in errors flattened to
  first-line strings with stacks captured at only 3 sites. D46 strict-zod + branded scalars +
  banned open bags is the correct counter-design.
- **The revision cycle worked.** Every finding in `reviews/01|02|03|09-review.md` is absorbed in
  the current text; D18/D69-class holes were found by adversarial spikes and fixed.

The problems are **sequencing, three deferred load-bearing unknowns, ceremony overshoot in named
places, and a set of spec defects** — detailed below.

---

## 2. Plan-level findings

### 2.1 Phase 1 is a waterfall mega-foundation — restructure it (HIGH)

As sequenced, the operator cannot run ONE workflow on the new base until all ten Phase-1 work
items (1a–1j) plus the Phase-2 read slice complete — 11 milestones; first production write at
Phase-3 order 6; the two workflows whose incidents motivated the program (separations,
onboarding) are orders 8–9. Meanwhile 1g-trust, 1h (data services + mobile capture + Edit Data),
and 1i (explorer + AI adapters) are built against synthetic fixtures with no consumer for months.

**Recommendation:** pull person-lookup forward as the *exit test of a minimal spine*
(1a → 1f + the span/projection slice of 1g + the queue-surface slice of 1i), and move the rest of
1g (evidence receipts, notifications, knowledge), all of 1h, and the explorer/AI parts of 1i
*behind* that first vertical proof. Rationale: a live workflow falsifies contracts a fixture
cannot; the plan's own stop-loss (b) scenario — a base-contract flaw found after the base is
"done" — is far cheaper to hit with 6 milestones built than 10. This preserves every contract in
docs 01–06; it only reorders delivery.

### 2.2 Three load-bearing unknowns are deferred deep but cheap to probe now (HIGH)

1. **The separations identity-approval gate has no design** (07 §3.3 order-8 note), yet the
   charter (§13) leans on it for the wrong-person incident class (`T002173685`) — the probe only
   closes double-*filing*. The single highest-stakes control in the program should get a design
   section (owner: doc 09 or a short 09-appendix) during Phase 0/1, not at order 8.
2. **Phase 2's controlled real-commit target is an unverified existential assumption** ("if no
   safe target exists, Phase 2 is blocked"). No candidate is named anywhere; doc 11 shows test
   URLs absent until configured. This is a Phase-0 operator question: which systems have a test
   instance or a sacrificial record we can write to? If the answer is "none," the write-proof
   strategy must be redesigned now, not discovered blocked in Phase 2.
3. **Kuali save-verify / OnBase upload-verify feasibility** (09 OQ1/OQ2) is deferred to
   migration order 7, but if OnBase lands on always-park, order-7 automation degrades to
   "operator manually confirms every upload." A half-day live spike each (read-back probe on a
   saved Kuali doc / an uploaded OnBase doc) would settle feasibility years of plan earlier.

### 2.3 The 60-day stop-loss contradicts the program-length window (MEDIUM)

07 §5.1(c) freezes migration when coexistence exceeds 60 days from first native cutover; the
charter and 07's Phase-1 invariant say UCPath/CRM dual-maintenance is "honestly program-length."
With ~10 migration orders after first cutover, (c) fires by construction. Either re-scope (c) to
per-workflow windows (time from a workflow's native cutover to its legacy deletion) or raise the
default with intent. As written the trigger will be waived, which neuters it.

### 2.4 Settle coordinator terminalization — gate vs projection (HIGH, small fix)

Doc 02 §5.7 says a display-only coordinator completes via a `children-terminal` **gate** (engine
event); doc 03 §4.3/§7 says member rollup is a **projection rule** and its worked example emits no
coordinator `span.ended`. A coordinator has no daemon task, so the mechanism decides whether its
terminal state exists in the greppable span stream at all. This is exactly legacy bug class
"coordinator stranded / mis-actioned" (ISS-006 family, ≥4 fixes) trying to re-enter. Pick one
(recommendation: a real kernel-owned record whose terminal transition is written by the engine on
last-child-terminal — i.e. the gate model — so cancel/delete/count/strand logic treats
coordinators uniformly), and update the non-owning doc.

### 2.5 Ceremony overshoot — named cuts for a single-operator tool (MEDIUM)

Keep in full: transaction probe/fence/subject-binding, write intents + probe-then-park +
settlement (D17/D18/D64/D69), page isolation, intake manifest atomicity, quarantine lift, backup +
restore drill. These map to real incidents. Cut or slim:

- **DSL-authored editor mode (12 §5.4):** a second graph-authoring pipeline (exclusive mode,
  codegen, isolated build, restart-gated apply, hash rollback) with plausibly zero real
  consumers — §b Q12's own phrasing expects everything real to stay source-authored, and the
  Phase-2 proof needs a *synthetic* workflow because no real one is named. Defer the whole mode
  until a migration questionnaire names a concrete DSL-authored workflow. Keep Phase-A read-only
  + Phase-B presentation editing + patch-scaffold briefs.
- **Notification inbox 5-state lifecycle (03 §2.6):** unread/read/acknowledged/snoozed/resolved +
  delivery-attempt records is multi-user incident tooling. A durable failure list with
  read/unread + optional snooze serves one operator.
- **CAS `expectedVersion` on every command (03 §2.4):** keep CAS where a real race exists
  (cancel-tree, edit-vs-resume, gate resolution, write-recovery actions); plain idempotent
  commands elsewhere (notification acks, hide). Halves the protocol surface.
- **Mobile-capture durability matrix (06 §5.1):** keep durable sessions + one durable finalize
  outbox; drop the restart-between-every-state scenario matrix for the lowest-stakes subsystem.
- **Ledger tamper-evidence:** keep the never-pruned ledger + atomic outbox + single projector;
  the hash chain + `ledger_heads` CAS + torn-tail protocol defend against an attacker the
  threat model doesn't contain (D33 concedes local tampering is out of scope). Simplify to
  append + verify-readable unless the operator wants tamper evidence.
- **D63 provider plumbing for trivial providers:** full capability ceremony for OCR (cost +
  fabrication risk) is right; a geocoder should not need six touch points. Add a "simple
  provider" tier (union entry + adapter + redaction class).
- **D70 lint-debt manifest at column granularity:** file+rule granularity is enough for debt
  that is scheduled for deletion.
- **Guard count (~80–100 promised in 01–06 alone, ~60 files registered in 10 §5.1):** add a
  priority tier to the guard inventory — `blocking` (write-safety, identity, projection
  coverage) vs `deferred` (text heuristics like ">90% identical run-body"). Build blocking
  guards with their phase; batch deferred ones opportunistically. Fragile text-heuristic guards
  (verb↔effect grep, note-message grep) should start as warnings, not allowlisted failures.

### 2.6 The per-task authoring floor (HIGH — this decides whether workflows #2–#10 are pleasant)

Docs demand ~10 artifacts per task (schemas, errorCodes, freshness, provenance, subject,
example, non-empty scenario tuple, naming compliance; commits add writeSafety + crash/subject
scenarios). Right for commits; heavy for a pure transform in a mini-store. Add an explicit
**minimum-viable-task floor**: `workflow:` mini-store pure reads need schemas + example only
(scenarios optional until the first incident); browser reads add freshness/provenance/subject;
commits pay full fare. Also commit to a **`scaffold new-workflow` / `scaffold new-task`
generator** in the base (nothing in docs 01–06 promises one; D55's explorer is read-only) — the
declaration toil is acceptable only if a generator emits the boilerplate with TODO markers.

---

## 3. Spec defects to fix in the docs (compact list)

1. **Type proof first** (01/02 headers, D41): the three-effect builder guarantee rests on an
   unbuilt 15–25-node type spike with a committed 5s/1GiB budget. It is correctly gated (1e) —
   but schedule it as the FIRST 1e action, with a stated fallback (runtime checks + smaller
   node union) if inference fails. Half the "fails tsc" claims depend on it.
2. **Checkpoint PK vs attempt semantics** (02 §5.7 vs 03 §1.1): `attempt` is per-run in 03,
   item-scoped in 02's PK and §8 example. A retry (new runId) either collides or the definition
   is wrong. Define once (recommendation: item-monotonic attempt owned by 02; 03 conforms).
3. **~⅓ of descriptor sub-shapes named but never pinned** (02 §1.1/03 §3.2):
   `WorkflowCapabilities`, `DetailProjectionSpec`, `MatchKeySpec`, `ItemIdSpec`,
   `WorkflowPresentationSpec`, `CoordinatorPolicy`, `CompletionConsumptionSpec`, `InputPreset`,
   `StepDisplayRule`, `ActionConditionRule`, `InputParserSpec`/`UploadFieldSpec`. The SSOT's own
   shape must be fully specified before 1e.
4. **Child item-id precedence** (02 §3.2 `deriveChildItemId` vs child `identity.deriveItemId` vs
   completion-stage `deriveItemId`): state precedence + add a consistency guard.
5. **Gate declaration drift** (02 `WorkflowGateSource` vs 03 §4.5 `subscribes` sketch): make 03
   conform to 02's shape.
6. **Scope-dependent gate status keys** (delegated `needsReview` vs standalone `in-review`) have
   no native descriptor mechanism — add a per-gate `statusKey` override on the child-run edge or
   drop the distinction.
7. **Worker-span file partitioning** (03 §2.1 "a daemon serves one workflow" vs 05's
   multi-workflow executor): stale line; decide executor-keyed span file naming.
8. **Scheduler yield vocabulary** (05 §1.1 yields vs 03's `RunRequeued.cause` lacking a yield
   cause): add `cause:"yield"` (+ a `waiting-for-budget` projection state) or forbid mid-run
   yields.
9. **`canonicalInput` authoring** (D62): as specced it is a hand-maintained duplicate of every
   input schema — provide a `deriveCanonicalSchema(input)` helper and define the input-snapshot
   migration artifact.
10. **`.instrument(hooks: TaskHooks<AnyTaskContract>)`** (02 §3) collapses hook typing to
    near-unknown while the docs ban that shape elsewhere — acknowledge or re-type per-node.
11. **`require()` bind helper** (02 §8) is load-bearing in the canonical example but owned by no
    doc — give it a contract (error shape, event, taxonomy).
12. **Fixture bugs:** 03 §7's `"employeeId":"12345678"` fails the resolved `Eid` regex
    (`/^10\d{6}$/`); worked examples are canon — fix.
13. **Doc 08 still displays retired contracts** (`effect:"mutate"`, five-beat sequence, §2.2–2.4)
    under a disclaimer header; strike through or excise — a future session skimming 08 can absorb
    a dead contract. Also: reconciliation rounds jump 5→7 in doc 04; add a one-line explanation
    or renumber.
14. **`span.patched` payload volume** (03 §7 rides a full OCR record array on a span): set a size
    rule; big payloads belong in notes/artifacts.
15. **Evidence-obligation declaration** (12 §2.3 keys receipt confidence off "declared completion
    criteria"): doc 02 must own the descriptor field that declares which observations are
    mandatory vs optional/non-load-bearing, or the receipt algebra has no schema.
16. **FailureRecord shape** is a `failureId` pointer within docs 01–06; doc 12 must pin its
    contents (zod issue tree, page-state observation, stack, knowledge links) before 1b encodes
    the failure schema.
17. **Notification ownership** is split 03(wire)/12(behavior) — name one owner in the D1 matrix.

---

## 4. Base additions this review proposes (missed factors)

1. **Dashboard UI canon (new subsystem, small).** Doc 12 §1 names elements of the *target HR
   systems*; nothing names the *dashboard's own* surfaces. Legacy evidence: one concept carries
   up to 5 code names ("operation coordinator" = OperationRow/coordinator/GroupRowBase/anchor/
   DelegationRow), visible "batch" strings survived the 2026-06-30 rename in ≥5 files, the
   session drawer has 5 names (`TerminalDrawer`/"session drawer"/"Sessions panel"/"daemon
   card"/"SESSIONS"), `data-testid` exists on exactly 1 element, and `title=` (199 uses) is an
   uncontrolled third naming surface beside aria-labels (155). The rebuild's dashboard gets:
   one `dashboard/ui-canon.ts` registry of canonical surface names (QueueRow, OperationCard,
   SessionCard, SessionDrawer, DetailColumn + its tabs, RunModal, InputRunPanel,
   StatusFilterStrip, WorkflowRail, …) with a short generated `DASHBOARD-CATALOG.md`; component
   file names, visible labels, aria-labels, and kebab-case `data-testid`s all derive from the
   canonical name; a guard bans retired synonyms in visible strings. This is how the operator
   and AI sessions reference the same element unambiguously.
2. **Checkpoint-payload read path for debugging (closes the "trace-alone" gap).** Task outputs
   live only in SQLite; spans carry summaries. `cli explain run <traceId>` must include (or
   offer via `--data`) the checkpoint payloads per step, and a read-only
   `cli storage read checkpoint <runId> <stepId>` must exist — otherwise an AI session cannot
   answer "what did step N actually return" from the trace alone, which was the point.
3. **A generated `DEBUGGING.md` at the rebuild root**: where spans/notes/ledger/evidence/state.db
   live, the two-grep recipe, `cli explain run`, screenshot addressing. Regenerated from the
   path registry so it cannot rot. (Operator requirement: "codex and claude know where the logs
   are located.")
4. **Notes retention 7d is too short** — action-level detail ("what did it do") is the first
   thing pruned, but bugs are often reported later than a week. Raise notes to ≥30d (disk is
   cheap; these are text lines) or make retention a settings field with a 30d default.
5. **UI-registry drift detection (`ui doctor`).** Legacy evidence: a `// verified 2026-05-15`
   selector chain was entirely dead in production by 07-08; 13 freeform "NEEDS LIVE RE-VERIFY"
   markers sat untracked for 4+ weeks; one guessed selector shipped as a fix. The semantic UI
   registry gets a scheduled re-verification lane: a read-only headless pass that probes each
   `LocatorRecipe`/`StateEvidenceRule` on its live page (Duo Autopilot, standing
   pre-authorization) and flips failing entries to `unverified` with a notification. Verification
   dates that are never re-checked are how the old system rotted while looking verified.
6. **Minimum-viable-task floor + scaffold generators** (§2.6 above) — named here because they are
   base deliverables, not doc edits.
7. **Knowledge-system hard requirements** (sharpening 12 §4 with the audit's evidence — 654 KB /
   ~160K tokens of lesson prose, 10:1 add:delete, zero audit sweeps ever run, and a documented
   mistake that recurred *past* its own warning comments until a ratchet test stopped it):
   - A record without machine-checkable code refs AND a pinning regression scenario/test is
     `unverified` by definition — the guard is the lesson's teeth; prose demonstrably does not
     change agent behavior.
   - The audit is **push-based** (scheduled cron/CI job that flips dead-ref records to
     `unverified` and surfaces a queue), never on-demand — the on-demand version existed and ran
     zero times.
   - **Single home per fact**: rebuilt-tree CLAUDE.md files contain contracts only; their
     "Lessons Learned" sections are replaced by generated active-only `KNOWLEDGE.md` views.
   - Incident narrative is stored separately from guidance with field length limits (no 4 KB
     chronicle bullets in the default prompt surface).
   - The **authoring interface must be specified**: a `cli knowledge add|supersede|audit`
     command family + a successor skill that writes records (the current skill appends
     markdown); records live git-tracked under `knowledge/records/`.
   - Session-scoped IDs (ISS-B04-style) are banned as evidence anchors — commit SHA, test path,
     scenario id only (legacy: same ID = two different bugs in two files, ledger nonexistent).
8. **AI-fix logging (operator question answered):** every Claude/Codex-assisted fix lands as a
   `FixRecord` (`requestedBy: operator|claude|codex`, failure fingerprint, affected ids/files,
   root cause, fix commit SHA, regression scenario id, verification evidence,
   `status: draft|verified`). Mechanical trigger for the "close" gap: the scheduled knowledge
   audit reconciles `fix(...)`-typed commits since the last sweep against FixRecords and lists
   unrecorded fixes as audit findings — enforcement by sweep, not by hoping the session
   remembers.
9. **Operator-time budget is a real resource:** §b questionnaires (12 questions × ~14
   workflows), guard maintenance, and as-built doc updates all draw on one person. The master
   plan should batch questionnaire sessions (e.g. answer §b for the next 2–3 workflows in one
   sitting) and cap the per-phase doc-update surface.

---

## 5. Operator-question resolutions this review recommends

### 5.1 Workflow editor: read-only first — with the run-timeline built early

Recommendation: **adopt doc 12 §5's staged hybrid, with the Phase-A read-only explorer treated
as a first-class debugging/trust surface, and the DSL-authored mode deferred indefinitely**
(§2.5). The read-only-vs-editable weighing, on legacy evidence:

- The legacy editor's two write channels were **never used once**: `config/workflow-presentation/`
  and `config/workflow-design/` (scaffolds) contain zero files. What was actually used is the
  *reference* half — the mined Data Bank (854 KB of op records) and the graph view. The operator
  edits behavior in code (with AI help); the editor's value is shared, unambiguous reference.
- In the rebuild the descriptor is typed code and the SSOT. A GUI that edits behavior is a
  second authoring path that must round-trip perfectly or it drifts — the exact disease the
  rebuild exists to cure. Constrained Phase-B editing (presentation, composition of *existing*
  tasks from closed unions) is acceptable later because it compiles through the same builder;
  arbitrary editing never is.
- The read-only explorer is also the transparency surface the operator asked for: descriptor
  graph as the static truth, and a selected run overlaid on the same graph as a **timeline**
  (timings, attempts, checkpoint reuse — including "reran with existing data" visibility —
  failures, children, evidence, safe actions). Build this with the first vertical slice, not in
  1i's tail, because it doubles as the primary debugging view for both the operator and AI
  sessions.
- Port from the legacy editor: the Data Bank op vocabulary (it is nearly a task-node vocabulary
  already; re-mine for freshness), the pure projection seam (graph↔model inverses pinned by
  tests), the lane/outline/focus UX third, and React Flow integration. Rebuild the model third
  and persistence third (they encode `WorkflowOverride`).

### 5.2 Lessons: replace, don't remove

The knowledge is genuinely valuable (spot-checks: ~60–90% of system-store entries still correct
and load-bearing — selector gotchas, iframe/mask timing, race classifiers). The *form* failed:
append-only prose, duplicated across 2–4 homes, contradictions without markers, refuted claims
left inline where a skimming agent extracts them, and instruction-based dedupe that demonstrably
does not bind agents. So: triage into doc 12 §4's structured records (already the plan), with
§4.7's hard requirements added. Delete nothing until its store's code is deleted (bounded dual
authority, already the plan).

### 5.3 Queue/delegation standard: ratify docs 02/03 as THE protocol

The bug archaeology independently validates the design (§1). Standard, in plain language: a row
is a kernel record born once with immutable identity; every status is a first-class enum value;
every actionable row is backed by a task whose original input is immutable and replayed on retry
(reconstruction paths banned); cancel/retry/hide are kernel verbs over the run tree with
per-workflow *policy*, never per-workflow *implementations*; delegation — including multiple
delegations per workflow — is a typed `child-run` graph node with a stable edge id, atomic
fan-out manifest, and declared join/failure/cascade policy; coordinators are real kernel records
(settle §2.4); counts come from the same projection the panel renders. Workflows customize only:
input schema, subject, presentation, gate semantics, fan-out mapping, rollup/partial-failure
policy — all declarative. HTTP routes (upload/approve) get a kernel operation handle; no route
ever mints its own parent id or calls enqueue raw.

---

## 6. Base feature list (webpage source)

Consolidates doc 12 §8's base capability inventory with this review's additions (marked ★).
Grouped; each line carries the old→new contrast for the comparison page.

**A. One typed definition per workflow**
1. Descriptor SSOT: one bundle-safe typed descriptor per workflow (graph, presentation, surfaces,
   identity, policies) — replaces ~10 hand-synced registries (loaders, run-surface lists,
   INSTANCE_LABELS, icons, step-label switches, e2e stubs, …) where a rename silently rendered
   stale text. Adding a reuse-only workflow: ~4 touch points (was: i9-check = 47 file-touches).
2. Typed task contracts: zod input/output/error schemas, branded scalars (Eid, DateOnly, …),
   literal error codes — contract changes fail compile, not production (was: `Record<string,
   string>` row bags, ~164 undeclared keys, booleans as `"true"` strings).
3. Two-level task stores: per-system stores + per-workflow mini-stores with peer-to-peer reuse —
   selectors and page interactions proven once, fixed once, reused everywhere (was: re-derived
   per workflow; the same selector bug fixed repeatedly).
4. Typed workflow graph builder: steps, transactions, branches, parallel, child-run, gates —
   dependency-scoped bindings checked by the compiler (was: imperative handlers + string steps).
5. Semantic UI vocabulary for HR systems: stable ElementId/ScreenId/PageStateId/ObservationId
   names with verification evidence; drivers wrap Playwright; raw locators banned outside infra
   (was: selectors referenced ad hoc; verified-dates that silently rotted).
6. ★ Dashboard UI canon: one canonical name per dashboard surface, derived aria/data-testid,
   generated catalog, retired-synonym guard (was: 5 names for one concept, 1 data-testid total,
   visible "batch" strings a month after the rename).
7. ★ Scaffold generators (`scaffold new-workflow`/`new-task`) + a minimum-viable-task tier so
   trivial pure tasks stay cheap to declare.

**B. Execution kernel**
8. Workflow-agnostic executor with lanes + pooled tabs — parallel by design (was: per-workflow
   daemons, serialized items, ~33s UCPath sleep tax; worked i9 example ≈12 min → ≈2.5 min).
9. Closed session-pool modes per system (UCPath parallel-reads/exclusive-transactions; OnBase
   serial with cross-process lease) — concurrency policy is data, not folklore.
10. Duo fully automated everywhere, production included (was: manual phone approval pauses).
11. Page-isolation invariant: one task per page, reset-or-close on release, poisoned pages
    closed (was: stale-page/wrong-person exposure in New Kronos).
12. Blind sleeps banned for new code; ported sleeps replaced per-file with live-verified
    condition waits under shrink-only budgets (was: 148 allowlisted `waitForTimeout`s).
13. Fairness + priority lanes + backoff; enqueue blocked only by storage health.

**C. Write safety (the trust core)**
14. Fill and submit are always separate prepare/commit tasks in one page-scoped transaction;
    dry-run structurally omits the commit arm — a dry run *cannot* submit (was: dryRun flags
    threaded by convention).
15. Seven-beat commit sequence: probe → prepare → subject-binding proof → fence → commit →
    proof → atomic durable record (was: click-and-hope; two real incidents: duplicate person,
    wrong-person termination T002173685).
16. Observed-subject binding: the page's actual person is re-observed and matched against intent
    immediately before every irreversible click; mismatch parks before mutation.
17. Fail-closed completion: unknown/unverifiable never becomes "done"; typed receipts
    (confirmation numbers) for UCPath/CRM/ServiceNow; save-verify for Kuali; upload-verify for
    OnBase (was: silent fallbacks could report false success — the operator re-checked work the
    automation claimed done).
18. Permanent write-intent registry with fenced idempotency keys: at most one unattended commit
    attempt per intent; retry only after stabilized negative evidence (D64/D69).
19. Never-pruned write ledger of what was actually filed, with `cli ledger verify`.
20. Parked-write resolution: typed proof attach or audited confirmed-absent — no generic
    Done/Retry escape hatch.
21. ★ Separations identity-approval gate designed in Phase 0/1 (was: undesigned until order 8).

**D. Data correctness**
22. Runtime validation at every boundary (SQLite, SSE, routes, config, JSONL): strict zod
    parse, never casts (was: `as T` on every DB read; SSE payloads unvalidated).
23. Workflow-constant input: raw submission stored immutable; canonical snapshot re-validated on
    every read; rerun-with-new-input is a new run (was: retry reconstructed input from display
    strings — once nearly re-enqueued a real termination).
24. Checkpoints with declared freshness + provenance per read; stale data feeding a write fails
    loudly with a named error (was: cached values silently reused).
25. Edit Data over checkpoints: parked runs expose live typed state; allowlisted fields editable,
    schema-validated; identity/proof read-only (was: opaque checkpoint blobs).
26. Operator-defined column mapping for spreadsheets: explicit header→field binding, per-cell
    typed rejection, no positional guessing (was: header drift silently mis-mapped columns).
27. Immutable intake manifests: every upload's rows, dispositions, corrections, and hashes
    recorded; reruns diff, never re-parse silently.
28. Content-addressed artifacts via a single kernel writer; mutable outputs (i9 workbook) are
    serialized outbox projections that cannot duplicate on retry.

**E. Observability & trust**
29. Span-based trace SSOT: every run/task/attempt is a span; timelines and durations computed,
    never hand-maintained (was: step labels re-declared client-side; durations reconstructed).
30. One trace id everywhere: rows, logs, spans, screenshots join on it (was: 7 surfaces, runId
    the only join key, session events attributed by heuristic time-windows).
31. Structured failure records: kind, code, subject, stack, page state — persisted per attempt
    (was: first-line string, stack captured at 3 sites in the whole tree).
32. Run evidence receipts: inputs, observations, decisions, actions, verification, reused
    checkpoints, warnings, confidence — "verified-done" only with complete declared evidence
    (was: "done" meant "the function returned"; the operator re-checked everything).
33. `cli explain run <traceId>`: the canonical debug entry ★ including checkpoint payloads
    (`--data`), plus a redacted exportable bundle.
34. ★ Generated `DEBUGGING.md`: one non-rotting page telling any AI session where every log,
    span, artifact, and DB lives.
35. Durable, deduplicated notification inbox (simplified lifecycle ★) — failures survive
    restarts; OS toasts best-effort only.
36. Row-lifecycle and daemon events with mandatory run/daemon ids at emit (was: heuristic
    attribution produced duplicated-log bug families).
37. ★ Notes retention ≥30d so action-level history outlives late bug reports.

**F. Queue, control, delegation (kernel protocols)**
38. One row-write authority; identity stamped once, immutable; updates are transitions (was: 48
    emit sites in 25 files re-writing whole rows; ≥8 field-loss fixes).
39. First-class statuses incl. cancelled/discarded/awaiting-approval (was: `failed` +
    step-string sentinels decoded in 32 places across 3 layers).
40. Exactly-once terminalization owned by the task store (was: multi-writer races managed by a
    bolt-on token protocol; ≥6 fixes).
41. One command protocol for retry/cancel/bump/hide with idempotent envelopes; CAS where races
    exist ★ (was: three cancel paths + 409-redirect dances; ≥5 routing fixes).
42. Hide-from-queue is reversible; destructive purge is a separate offline command (was: delete
    tombstones over a two-source descendant scan).
43. Typed delegation: child-run nodes, stable edge ids, atomic fan-out manifests, declared
    join/failure/cascade policy — multiple delegations per workflow are just multiple edges
    (was: 7 flavors, 7 parent-link mechanisms, 4 parent concepts, hand-rolled UUIDs in routes).
44. Coordinators are real kernel records with uniform cancel/delete/count semantics (was:
    display-only rows + projection-time anchors; stranded-coordinator bug family).
45. Rail badges/counts derived from the identical projection the panel renders (was: ≥4
    count-vs-panel divergence fixes).

**G. Storage & recovery**
46. SQLite as transactional authority with startup integrity checks, read-only rescue mode, and
    new-writes-disabled on unknown health.
47. Verified online backups + mandatory pre-migration backup + automated restore drill (was:
    irreplaceable local state with no recovery contract).
48. JSONL streams as projections (spans 30d / notes ★30d / ledger forever), rebuildable from
    authority.

**H. Scenarios, knowledge, AI**
49. Scenario corpus per task/workflow: real page states become named, replayable scenarios;
    unexpected states fail visibly and become scenarios — never silent fallbacks (was:
    "improve as I run it" with no place to put the learning).
50. Structured knowledge records with status/scope/supersedes, active-only generated views,
    ★ machine-checked code refs + pinning regression test required for `active`, ★ push-based
    scheduled audit (was: 654 KB of append-only prose, 10:1 add:delete, contradictions unmarked,
    audits never run).
51. FixRecords for every AI-assisted fix: who asked, what failed, root cause, commit, regression
    scenario, verification — ★ reconciled against fix-commits by the scheduled audit (was: fixes
    lived only in chat transcripts and commit messages).
52. AI is advisory-only evidence: OCR/normalization/triage return provenance-labelled
    suggestions; AI can never select a person, resolve a gate, or authorize a commit.
53. ★ `ui doctor`: scheduled re-verification of UI-registry recipes against live pages; failing
    entries flip to `unverified` with a notification (was: verified-dates that rotted silently).

**I. Config, clock, secrets**
54. One clock interface (sole `Date.now()` site), FY-keyed annual dates that throw when stale.
55. Config with provenance (env > settings > default), per-run resolved-instance snapshot,
    prod/test URL split where test URLs cannot silently replace prod.
56. One secrets registry with redaction classifications applied at capture; loopback-only server
    (phone-capture ingress the sole scoped exception).

**J. Workflow editor & migration honesty**
57. Read-only Workflow Explorer from Phase 1: the real descriptor graph + live-run timeline
    overlay (timings, attempts, checkpoint reuse, children, evidence) — one shared reference for
    operator and AI sessions (was: a presentation-override editor whose two write channels were
    never used once).
58. Constrained editing earned after Phase 2: presentation + closed-union composition through
    compile/validate/diff/version; arbitrary code/selectors/proofs stay code work; ★ the DSL
    authoring mode deferred until a real consumer is named.
59. Capability inventory closure: every legacy workflow/route/tool gets a
    native/replaced/retired/proxy disposition; old `src` cannot be deleted while any entry is
    undecided.
60. Per-workflow migration questionnaire (§b): the operator is asked the 12 workflow-specific
    questions (real submits, receipts, probe policy, dry-run boundary, quirks) at migration
    time, so nothing is assumed.

---

## 6.5 Operator answers + live evidence (2026-07-23 update)

Answers received in review session 2026-07-23 (remaining questions moved to the interactive
decision sheet artifact "Rebuild: Remaining Decisions"):

- **Phase-1 restructure (§2.1): ACCEPTED.** Person-lookup becomes the exit test of the minimal
  spine; trust/capture/data-service/explorer tails move behind the first live proof.
- **Separations identity gate (§2.2#1): ALWAYS-GATE**, for both separation types the operator
  distinguishes (Kuali separations and I-9 separations). Manual approval every time; no
  auto-approve-on-match mode.
- **Dry-run policy: operator-triggered, no mandatory quota.** Workflows are built testing-first
  so an AI session can run and debug a dry run on request; the operator chooses when.
- **Phone capture: rarely used** (most documents arrive as scanned PDFs) — supports the §2.5
  capture-durability slim.
- **Test targets:** test employees/files live in `data/` (fixture PDFs, e2e roster + identities
  sidecar, i9 scans + extracted records, Employee Action History roster). Kuali Action List docs
  **4444–4453** (RRSS Separation Request Forms, new/unworked) authorized for probing: read-only
  by default; writes allowed if removed after; save allowed with nothing written.
- **Testing standardization:** operator asked for a better standard than the
  `custom-hr-e2e-test` skill ritual. Proposal (in the decision sheet): scenario corpus as the
  everyday lane + structural dry-run + a **TestTargetRegistry** (typed registry of test
  employees/files/sacrificial docs with usage rules) + `cli test workflow <id> --dry-run` through
  the real kernel + **positive no-write proof from an empty per-run write-intent ledger**
  (replacing the old screenshot-absence heuristics). Old skill's keepers: "a workaround is a
  finding," double-entry ground truth, issue ledger — as built-in kernel behavior.

**Kuali save-verify live probe (09 OQ1): RESOLVED — BUILDABLE.** Run 2026-07-23 under the
operator authorization above. Doc 4453 read-only: all separations-relevant fields
(name/EID/LDW/sep date/term type/timekeeper/status) read deterministically by role+exact-label
from the a11y tree; byte-identical across reload. Doc 4444 write round-trip: timekeeper field
(the benign field the legacy flow fills on drafts) written `PROBE-DELETE-ME` → Save → reload →
value persisted; cleared → Save → reload → empty; full-form normalized diff before/after clean
(doc restored byte-identically; no workflow buttons touched). Key findings for the verifier
design: **save success is UI-silent** (no toast/banner — reload read-back is mandatory, matching
the 2026-04-10 lesson); date values render as child text nodes; DOM refs change every reload
(anchor on role + exact label, literal `*` included); the doc URL is a stable reload-safe deep
link but carries an opaque actionId (capture URL at open); `.trim()` before compare; full
fill→save→reload→verify ≈ 8–10s/doc. Evidence: `.screenshots/kuali-probe/` (6 PNGs + 5 a11y
dumps). Remaining half of §2.2#3: **OnBase upload-verify probe — needs an operator-named
uploaded target doc** (asked in the decision sheet).

## 7. Legacy evidence appendix (headline numbers)

- Registries to touch for a new workflow: ~19 candidate files, 9 mandatory; i9-check split = 47
  file-touches / ~3,260 lines across 2 commits; icon + schema-export registries drifted on that
  newest workflow (i9-check's `FileSearch` icon silently falls back to generic).
- Queue/projection special-casing: 114 sites in 30 files; 48 `emitTrackerRow` calls in 25 files;
  status decoded from step strings at ~32 sites; the failed→cancelled override implemented 3×.
- Delegation: 7 flavors; 7 parent-link mechanisms (+2 adjuncts); supersede root-only; retry
  authority differs per flavor; 2 hand-synced copies of the coordinator workflow set.
- Recurring bug classes (each fixed 2–8×): sparse re-emit field loss (≥8), status
  misclassification (≥6), double/missing terminal writes (≥6), retry input reconstruction (≥8),
  orphaned members/anchors (≥6), stranded coordinators (≥4), count divergence (≥4), cancel
  routing (≥5), trace lineage (≥5), lost wakeups (4). Commit-grep volumes: row 773, queue 377,
  batch 230, delegat 221, retry 177, cancel 159 (of 2,147 commits).
- Typing: `Record<string,string>` ×207, `Record<string,unknown>` ×269, `as unknown as` ×56 (13 in
  workflow-loaders alone), 89 `JSON.parse` sites vs 9 zod-importing files; ~170 hand-reviewed
  fail-loud allowlist survivors; stack traces persisted at 3 sites.
- Lessons: ~48 stores, ~500 entries, ~654 KB (~160K tokens); adds:deletes 10:1; zero audit
  sweeps; 13 untracked "NEEDS LIVE RE-VERIFY" markers; same ephemeral ID (ISS-B04) meaning two
  different bugs in two files; a documented mistake recurring past its own warning comments
  until an architecture test stopped it.
- Dashboard naming: 122 components; 1 `data-testid`; 155 aria-labels vs 199 uncontrolled
  `title=`; visible "batch" strings in ≥5 files post-rename.
