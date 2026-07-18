# Reconciliation memo — binding cross-doc decisions (2026-07-17)

Three adversarial reviews (`reviews/01-review.md`, `reviews/02-review.md`, `reviews/03-review.md`)
found that docs 01–03 describe divergent systems at their seams. This memo is the orchestrator's
binding resolution. **Every decision below overrides anything contradicting it in docs 01–03.**
Amendment agents rewrite each doc to comply; a doc may reference another doc's owned contract but
must never redefine it.

## D1 — Contract ownership matrix (one owner per concept, others reference)

| Concept | Owner |
|---|---|
| Task contract (`defineTask`), id grammar, error taxonomy, effect/dry-run mechanics, retry policy, decoration, stores, session providers, shared leaf-code homes | **Doc 01** |
| Workflow builder API (single API), descriptor shape, RunEnvelope, run-state machine incl. gates/parks, checkpoint/resume model | **Doc 02** |
| Span/event wire schema, notes stream, storage layout, lift adapter, SSE wire shapes, completion (fan-out/approval) union | **Doc 03** |

Each doc gets a header table stating what it owns and what it imports from siblings.

## D2 — Task identity
`<system>/<verb-object>` slash grammar (doc 01's). One closed `SystemId` union covering browser
systems (named after the REAL `src/systems/` dirs — `new-kronos`, `old-kronos`, not `kronos`) plus
service systems (D4). Doc 02/03 examples updated (`ucpath.searchPerson` etc. are wrong).

## D3 — Client-safe contract split (resolves the bundle-fault-line collapse)
A task is split into:
- **contract** — plain data: id, zod input/output, title, effect, errorCodes, freshness (D8),
  mandatory `example` output. Lives in `temp_src/domain/contracts/<system>/` (bundle-safe, satisfies
  the "descriptors import only zod + domain" guard).
- **impl** — `run` + session needs, lives in the store (`temp_src/stores/<system>/tasks/`), imports
  Playwright. `defineTask(contract, impl)` binds them; the store is the only impl registry.
Descriptors and the dashboard import contracts only. E2e stubs derive their happy path from
`example` (schema-parsed); failure/cancel/parallel scenarios REMAIN hand-scripted in the stub lane
(examples cannot express them — review 02 #12).

## D4 — System-less work gets service stores
Service stores (`local` for pure compute like PDF extraction/roster matching, `ocr-llm` for the OCR
provider pipeline) use the same contract; `sessions: []` is legal ONLY for service stores; browser
stores stay type-constrained to their own system's sessions.

## D5 — Waits and operator gates are run-state, not task internals
Tasks remain run-to-completion with bounded duration. Long waits (OCR approval, child-signature
watching, external signals) are **gate nodes** declared in the descriptor and owned by doc 02's
run-state machine; doc 03's `gate.opened/resolved` events are their wire form. Kernel policy: a
parked run RELEASES its browser sessions; resume reacquires via the store session provider
(re-login is idempotent). Duo is cleared automatically by Duo Autopilot on EVERY login — production
included (operator directive 2026-07-17, charter §9): there is no phone-approval poll, pause, or
manual-MFA path anywhere in the new design. Login is always unattended and bounded.

## D6 — dryRun lives on the RunEnvelope (kernel-owned), never in workflow input. Doc 02's table is amended.

## D7 — Write-ness is derived, never re-declared
`TaskStep.write` is DELETED. All write gating (refuse-replay, crash-park, freshness) keys off the
contract's `effect: "mutate"`. `defineTask` uses per-effect overloads so a mutate contract without
dry-run handling fails to compile where possible, with the runtime factory check as backstop (docs
must say "compile-time where possible, runtime-enforced always" — not overclaim "type-level").

## D8 — Checkpoint freshness (closes the stale-read→live-write hole, review 02 #2)
Every checkpoint records `capturedAt`. Every read contract whose output may feed a write declares
`freshness.maxAgeMs` (mandatory field on ALL read contracts; `Infinity` must be written explicitly
and justified in a comment). At resume, the kernel walks the step bind graph: if any replayed
checkpoint feeds (directly or transitively via later mappings) a mutate task in this run and its
age exceeds `maxAgeMs`, the kernel REFUSES loudly — naming the checkpoint, its age, the limit, and
the consuming write task — and requires either `always-rerun` of the producing task or explicit
operator override. Crash-mid-write still parks `needs-operator`.

## D9 — Resume-model scope (explicit)
Resume covers rows with a real daemon task only (`single`, real `operation-member`). Explicitly
excluded: display-only rows (operation coordinators, i9 display-only members — nothing to resume)
and the OCR per-page pipeline (one task externally; its page pool keeps internal checkpointing,
surfaced as notes). Doc 02 fixes its schema to reality: `tasks.id` is `TEXT`, the logical key is
`(workflow, item_id)`.

## D10 — One event schema (doc 03's union, amended)
Doc 03's discriminated-union event stream is THE wire contract; doc 02 §4 becomes a reference.
Amendments to 03's schema: span identity = `(runId, attempt, spanPath)` using doc 02's readable
path-style span ids; `worker` kind and first-class `discarded`/`interrupted` outcomes kept; in-run
kernel retries = attempt-suffixed task spans, cross-run retries = `retryOf` new run; the legacy
`-N` display suffix stays display-only formatting. **Action spans move to the notes stream** (task/
run/gate spans stay in `spans/`) — preserves per-action attribution via spanPath without exploding
the span stream; timeline folds read spans only. SSE member payloads send ids + deltas, never fully
resolved nested member trees.

## D11 — Completion union re-derived from as-built code
Doc 03 §4 is rewritten against `tracker/dashboard/ocr/approve.ts` + `prepare.ts` as-built, and must
express: intent-derived child shape (operationWorkflow), `deriveItemId`, the per-document target
consuming the per-record target's actually-enqueued itemIds (ordered stages, not flat independent
targets), oath-upload's owner-consumes via a sibling born-at-upload task (`subscribeToApproval`) with
NO coordinator, and i9's prepare-route member enqueue + task-less display-only failed rows. Stay
declarative (typed staged completion program on the descriptor); if a case truly cannot be declared,
the doc says so explicitly rather than mis-modeling it.

## D12 — Lift adapter re-derived from the kernel terminal contract
Mapping enumerated from `tracked-workflow.ts` (plain `done`, `failed`-with-step, `skipped`,
`interrupted`, `superseded`, pseudo-step `<step>:failed:<err>`, approve/ocr-prep failures), not the
OCR happy path. Lift reads the visible-entries layer (deletion tombstones respected). Quarantine
(loud card), NEVER throw — including post-cutover legacy rows and invalid archetypes. No fabricated
`run.claimed`/worker spans for task-less display rows. Gates outside OCR are enumerated per
workflow (EID/identity-approval, standalone-OCR approval with no parentRunId). Pinned by replaying
real `.tracker` days through the lift asserting zero quarantines.

## D13 — The dashboard flip is SCOPED, not wholesale (operator-reviewable)
Parity gate covers queue rows + log panel + session cards + wfCounts only. Capture, workflow-
modifier, settings, AI-assist proxy to the old endpoints until their own migration milestones.
One-week legacy-dashboard fallback stays. (Review 03 sized wholesale flip at ~103 endpoints / ~122
components — an unacceptable pre-Phase-2 mega-milestone.)

## D14 — SQLite role
SQLite remains system-of-record for claims + checkpoint payloads (NOT rebuildable/deletable);
spans/notes JSONL is the display/audit source. Doc 03's "deletable projection" claim is scoped to
projection tables only.

## D15 — Doc 01 compile-level + porting fixes (all accepted from review 01)
Builder accumulates a `Steps` type map so `decorate` can type its hooks; step mappings return
`z.input<In>` while `run` receives `z.output<In>`; `const` type parameter for `errorCodes` + a
type-level test pinning that undeclared codes fail tsc; ONE login signature
(`Promise<"logged-in" | "already-authenticated">`) with the bool adapter named as a wrapper (not
"verbatim"); OnBase exclusivity = cross-process SQLite lease from day one; the UCPath store
selectors file RE-EXPORTS `src/systems/ucpath/selectors.ts` until deletion day (kills dual-
maintenance drift; same pattern offered to other high-churn stores); `onError` hooks: the base
TaskError ALWAYS propagates, hook failures attach as secondary metadata (pinned by test); dry-run
consultation asserted at the mutation primitives (submit helpers), with legitimate no-op
completions (duplicate-hire skip) given defined semantics; `stores/common/` added for shared leaf
code (`src/systems/common/`).

## D16 — Labels and overrides: exactly two layers
Step label = descriptor `step.label`, defaulting to the contract's `title`. The ONLY override layer
is the operator presentation override (serve-time, visible in settings). Precedence stated once, in
doc 02. The worked example task (`ucpath/search-person-org`) is defined once, in doc 01 §9; doc 02
imports it verbatim.
