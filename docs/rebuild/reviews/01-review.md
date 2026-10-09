# Adversarial review — 01-task-contract.md (2026-07-17)

Verdict: **buildable with amendments.** Findings 1–2 must be answered in doc 01 itself; 3–9 need
concrete revisions before Phase 1. Resolutions: see `../04-reconciliation.md` (D4, D5, D15).

1. **BLOCKER — No contract for tasks that park for operator input or poll for hours.**
   `src/workflows/oath-upload/handler.ts:126-215` parks at awaiting-approval (cross-process
   `subscribeToApproval`), then wait-signatures watches child runs for hours; production Duo is a
   manual phone-approval poll (`src/infra/auth/duo-poll.ts`, `login.ts:177` ×7). Doc models a task
   as a run-to-completion Promise with `attempts: 2|3`; never mentions pause/park/session
   release/reacquire. Must answer: does a parked run hold browser sessions; is "wait" a task, a
   workflow node, or a kernel state? → Resolved by D5 (gate nodes, sessions released).
2. **BLOCKER — System-less work has no store home.** Stores strictly per browser SystemId, but
   onboarding `extraction` (pure PDF parse, `src/workflows/onboarding/workflow.ts:215`), the OCR
   LLM pipeline (`src/services/ocr/`), roster matching, and tracker-subscription waits touch no
   browser system. → Resolved by D4 (service stores, `sessions: []` legal only there).
3. **MAJOR — `FlowBuilder.decorate` not implementable as sketched** (doc :334): `TaskAt<Name>` is
   unrecoverable — builder accumulates only output types. Fix: accumulate a second `Steps` generic
   map (name → task type). → D15.
4. **MAJOR — `z.infer` vs `z.input` conflation:** `TaskInput<T> = z.infer<In>` makes
   `.default(false)` fields required in step mappings, defeats defaults/transforms. Fix: mappings
   return `z.input<In>`; `run` receives `z.output<In>`. → D15.
5. **MAJOR — `errorCodes` literal inference collapses to `string[]`** without a TS5 `const` type
   parameter — `ctx.fail` would accept any string silently. Fix: `const Codes` + type-level test
   pinning that an undeclared code fails tsc. → D15.
6. **MAJOR — OnBase "process-pool-wide" exclusivity doesn't survive deployment:** daemons are
   separate OS processes (`src/cli-daemon.ts`); the OnBase lesson is cross-session contention. An
   in-process queue can't serialize two daemons. → D15: cross-process SQLite lease from day one.
7. **MAJOR — Three incompatible login signatures:** §6.1 `Promise<void>` vs §9.3
   `.then(r => r === "already_logged_in")` vs real `Promise<boolean>`
   (`src/infra/auth/duo-login-flows.ts:20`). → D15: one signature
   `Promise<"logged-in" | "already-authenticated">`; adapter is a wrapper, not "verbatim".
8. **MAJOR — UCPath dual-maintenance window has no mechanical drift guard** (27 commits on
   selectors.ts, ~7 since June). → D15: store selectors RE-EXPORT the old registry until deletion
   day.
9. **MAJOR — dryRun recording-getter tripwire bypassable (`const { dryRun } = ctx`) and
   false-positive on legitimate no-op completions** (duplicate-hire "Already Submitted" skip,
   `src/workflows/onboarding/workflow.ts:459ff`). → D15: assert consultation at mutation
   primitives; define no-op completion semantics.
10. **MINOR — "dryRun REQUIRED (type-level)" overstated** — property is optional, only runtime
    check catches it. → D7 wording: compile-time where possible via per-effect overloads,
    runtime-enforced always.
11. **MINOR — `onError` can mask the base failure** ("decorator-failed" replacing "submit
    failed"). → D15: base TaskError always propagates; hook errors attach as secondary; unit test.
12. **MINOR — Cross-store shared leaf code (`src/systems/common/`) has no home.** → D15:
    `stores/common/`.
