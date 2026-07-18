# 08 — Foundation Gap Audit: the unowned cross-cutting concerns

Status: **Phase 0 design — for operator/orchestrator review.** A principal-architect pass over the
four written design docs (01 task-contract, 02 workflow-model, 03 tracker-dashboard, 05 execution),
the charter (`00`), and the binding reconciliation (`04` — D1 ownership matrix). This doc **owns
nothing** yet: it is a findings-and-design memo that names what the foundation of a production,
single-operator, **real-HR-transaction** system needs that no doc currently owns adequately, ranks
the gaps by risk, and designs the top three. Docs 06 (data-intake/Edit-Data) and 07 (master-plan)
are planned-but-unwritten and are **not** counted as gaps here.

Every finding is grounded in the as-built code (file:line cited), not imagined — because for a
rebuild that ports live-verified leaf knowledge, a concern we fail to *own* is one we will
re-derive badly or drop, and a dropped write-safety concern is a real wrong-person HR transaction.

---

## 0. Method and the one-sentence thesis

The four docs are excellent at what they scope, and each ends with a sharp adversarial-review guard
table. But those guard tables are **per-doc promises made in isolation** — nobody owns the *suite*.
And three genuinely cross-cutting foundations sit in the seams between docs, each currently a
punted open question rather than an owned contract:

> **The single highest-stakes finding: the system today has NO durable transactional layer — no
> idempotency keys, no write-ahead intent record (except in exactly one workflow), and two of four
> target systems (Kuali, OnBase) capture NO positive receipt at all. Every "did the write land?"
> and "did we already write it?" is answered by re-probing the live target page, biased
> `fail-open → SUBMIT`. Doc 02 §5.6 parks `needs-operator` on crash-mid-write and §OQ2 explicitly
> leaves the disambiguating probe as an *optional* open question. The rebuild must promote
> write-safety to a first-class, mandatory contract or it will faithfully port a design whose
> documented failure mode is duplicate people and wrong-person terminations
> (real incidents: duplicate person from rehire misclassification `ucpath/LESSONS.md:212`;
> wrong-person termination `T002173685` requiring manual reversal, separations CLAUDE.md).**

---

## 1. Ranked gap table

Risk key: **BLOCKER** = the foundation is unsafe/dishonest without it (must be owned before Phase 2);
**MAJOR** = a real production hazard that will bite within the first migrations; **MINOR** = should
be owned but is bounded / partially covered.

| # | Concern | Owned today by | Risk | Recommended owner |
|---|---|---|---|---|
| 1 | **Write-safety: receipt capture + idempotency probe + exactly-once across the crash window** | UNOWNED — doc 01 mutate output has no required receipt; doc 02 §5.6 parks only, §OQ2 punts the probe as *optional* | **BLOCKER** | **NEW doc 09-write-safety** (contract side references doc 01; execution references doc 02 §5) |
| 2 | **Guard/test architecture SSOT** — porting the ratchets to `temp_src`, the dry-run *composition* guard, the fill↔submit pairing guard, the descriptor meta-coverage guard | PARTIAL — each doc lists its OWN guards; no doc owns the suite, and the two safety-critical guards don't exist even in spec | **BLOCKER** | **NEW doc (10-guard-architecture)** referencing every doc's §guards |
| 3 | **The clock** — one injectable, single-source time (freshness `now`, trace-id time-of-day, fiscal rollover, span ts) | UNOWNED — 445 direct `new Date()`/`Date.now()` reads; the D8 freshness *safety* mechanism computes `now − captured_at` off an unmockable wall clock | **BLOCKER** | **NEW `domain/clock` section** (doc 01 annex or its own short doc); consumed by 02/03/05 |
| 4 | **Config precedence + per-system instance selection (test vs production)** | PARTIAL — `config.ts` + `settings/*` is a real single-source, but precedence is re-implemented per read-site, defaults duplicated, URL overrides are **process-global not per-run** | **MAJOR** | doc 01 annex (`stores/common/config`) + a RunEnvelope field (doc 02) |
| 5 | **Audit trail / transaction ledger** — immutable record of what real transactions were filed, surviving pruning | ABSENT — JSONL is append-only-by-convention (`O_APPEND`), unsigned, no hash-chain, pruned at 30d; no dedicated ledger | **MAJOR** | folds into gap 1 (receipts ARE the ledger) + doc 03 retention floor |
| 6 | **Secrets / .env / .auth as an owned accessor** | PARTIAL — `validateEnv` is a clean choke for SSO, but `.auth/` Duo keys + LAN password + ~48 `process.env` reads in ~15 files escape it | **MAJOR** | with gaps 3/4 (`domain/environment`) |
| 7 | **Fiscal-year rollover as fail-loud data** | UNOWNED — `ANNUAL_DATES` are static literals mirrored in two files + a dated filename; already stale (`jobEndDate 06/30/2026`), silently | **MAJOR** | with gap 4 |
| 8 | **Schema/data migration across deploys** | PARTIAL — SQLite has a real versioned framework (`LATEST_SCHEMA_VERSION=23`, `MIGRATIONS[]`, `db.ts:130`); checkpoint `schema_hash` fail-loud refuses (doc 02 §5.7). Contract-schema→checkpoint deploy story under-owned | MINOR | doc 02 amendment |
| 9 | **Module-layout / dependency-direction enforcement** | PARTIAL — layer order is DOCUMENTED-only; only the `control` edge, cross-workflow, cycles, and default-exports are guarded. No `domain→…→workflows` matrix | MINOR | fold into gap 2 |
| 10 | **Structured logging homes** (log ↔ notes ↔ spans boundary) | OWNED — `log.ts` singleton + `AsyncLocalStorage` context + `console.*` guard. Rebuild must re-home logs onto the notes stream (doc 03) | MINOR | doc 03 amendment |
| 11 | **Daemon/browser-health recovery ladder** | PARTIAL — doc 05 references it as "ports as pool behavior" but does not enumerate verdicts/rungs; it is load-bearing for real long runs | MINOR | doc 05 amendment |

---

## 2. TOP GAP 1 — Write-Safety Contract (receipt · idempotency probe · exactly-once)

**Thesis: every mutate task must capture a verifiable RECEIPT and declare an idempotency PROBE, so
"did the write land?" is answered — never assumed — and no retry/resume/crash can double-file. The
one existing crash-window pattern (oath-upload's `submitAttempted` marker) is generalized into the
kernel.**

### 2.1 What exists today (the port inventory — this code moves in, wrapped)

| System | Receipt today | Grounding |
|---|---|---|
| UCPath | **Strong** — captures the `T…` transaction number by a second-navigation list scrape; *throws* "outcome unknown, refusing to report success" on ambiguous render | `transaction.ts:840,852-861,886,919-965` |
| ServiceNow | **Medium** — parses `HRC0…` from the post-submit redirect URL; throws if no `number=` | `oath-upload/fill-form.ts:140-162` |
| Kuali | **NONE** — `clickSave` = click + `networkidle` + 2s, "sufficient confirmation"; error detection deliberately removed as false-positive-prone | `kuali/navigate.ts:634-652` |
| OnBase | **NONE (negative only)** — asserts the landing page is *not* an ASP.NET error page; no positive "filed" receipt | `onbase/navigate.ts:531-538`, `handler.ts:213-217` |
| Idempotency (all) | **No keys** — live-page existence probes, `fail-open → SUBMIT` on uncertainty | onboarding `workflow.ts:498-521`; separations `steps/ucpath-transaction.ts:89-104` + date-agnostic `deletePendingTransaction` sweep |
| Crash-window | **oath-upload ONLY** — `submitAttempted` write-ahead marker + `hasUnverifiedPriorSubmit` refuse-and-escalate | `oath-upload/handler.ts:309,431-454` |

The strong UCPath receipt-scrape and the oath-upload marker are exactly the live-verified knowledge
the charter forbids re-deriving — they port. The gap is that they are per-workflow accidents, not a
foundation contract.

### 2.2 The contract addition (extends doc 01's `MutateTaskContract`)

```ts
// temp_src/domain/contracts/base.ts — additive on the MUTATE arm only
export interface MutateTaskContract<Id, In, Out, Codes> extends TaskContractBase<Id, In, Out, Codes> {
  effect: "mutate";
  dryRun: "simulate" | "unsupported";                 // doc 01 §2.2, unchanged
  /** PROOF the transaction landed — a NON-EMPTY subset of `output` that a human/audit can verify
   *  in the target system (confirmation number, ticket id, a post-submit read-back key). A mutate
   *  run returning submitted:true whose receipt fails this schema is a FAIL-LOUD park, never "done".
   *  Kuali/OnBase (no receipt today) must EARN one — a post-submit read-back of the filed doc —
   *  before their submit tasks are allowed to report success. */
  receipt: z.ZodType;
  /** Answers "is this exact transaction ALREADY present in the live system?" BEFORE the submit,
   *  and again on crash recovery. This makes doc 02 §OQ2's optional probe MANDATORY. */
  idempotency: {
    probe: TaskId;                 // a read task in the SAME store, e.g. "ucpath/find-existing-termination"
    key: (input: z.output<In>) => string;   // the natural key: EID ⊕ txn-type ⊕ effective-date
  };
}
```

### 2.3 Kernel execution (owned by doc 09, references doc 02's run-state machine)

A mutate task runs as a fixed five-beat sequence the kernel drives — the impl author cannot reorder
it:

1. **Probe (pre-write).** Run `idempotency.probe` (a `freshness:{maxAgeMs:0}` always-live read). If
   it returns a matching receipt → complete `done` with `{ submitted:false, reason:"already-present",
   receipt }` (doc 01 §6.2 honest no-op semantics), emit an audit note. **No second submit.** A probe
   returning *ambiguous* (>1 match) → `ctx.fail` + park `needs-operator`, NEVER guess.
2. **Fence.** Emit a new first-class span event `write.attempting` carrying `idempotency.key(input)`,
   **committed to SQLite before the click** (doc 03's ordering invariant: SQLite commit precedes the
   span). This is the crash-window fence.
3. **Submit.** The `stores/common/mutation.ts` primitive fires (doc 01 §6.2 — it already throws if
   `ctx.dryRun`). The fence emit is folded INTO the primitive wrapper so it cannot be skipped.
4. **Capture.** Read back the receipt; parse through `contract.receipt`. A missing/empty receipt
   ⇒ park `needs-operator` ("clicked, cannot prove it landed — verify in <system>"), never `done`.
5. **Commit.** Receipt checkpoint (doc 02 §5.7) + `write.committed` span event.

**Exactly-once across the crash window (resolves doc 02 §OQ2).** Recovery finds `write.attempting`
with no `write.committed`. Instead of blindly parking (doc 02's current default), the kernel
**auto-runs the same `idempotency.probe`**: probe hit → the write landed, backfill the receipt,
complete `done`; probe miss → it never landed, safe to retry. Only an *ambiguous or failed* probe
parks `needs-operator`. This is the exactly-once story the current `fail-open → SUBMIT` doctrine
lacks.

### 2.4 Composition with the existing docs

- **Charter §a fill/submit split.** The fill task is `effect:"read"` and carries no receipt/probe;
  the submit task IS the transaction boundary and carries the whole triple. A **dry-run composition
  excludes the submit task entirely (charter §a) — so there is nothing to make idempotent or
  probe in a dry run.** The write-safety contract only ever engages on a real submit. Clean.
- **Doc 01 §6.2** — the mutation-primitive wrapper is the single home for both the dry-run throw
  and the `write.attempting` fence. One choke point.
- **Doc 02 §5.6/§5.7** — receipts are `replay:"checkpoint"` outputs; a mutate step whose receipt
  checkpoint exists already refuses re-execution. Gap 1 upgrades "park on crash" to "probe then
  park only if indeterminate."
- **Doc 03** — `write.attempting`/`write.committed` are two new span events; the receipt is a
  `span.patched` detail on the run; the audit ledger (gap 5) is the durable set of `write.committed`
  events kept past the pruning floor.

### 2.5 The guard (fail-loud, ratchet)

`tests/unit/architecture/write-safety-contract.test.ts` — every `effect:"mutate"` contract MUST
declare a non-empty `receipt` AND an `idempotency.probe` resolving to a real `effect:"read"` task in
the same store, OR carry an allowlisted `{ reason }` justification (a genuinely idempotent write —
rare, must be argued). Unit-pinned: a mutate `run` returning `submitted:true` with a receipt failing
its schema throws; the recovery path is pinned by a fixture that injects `write.attempting`-without-
`committed` and asserts the probe runs. Mechanism mirrors the existing `Record<file,{count,reason}>`
ratchet shape.

### 2.6 Port inventory

UCPath `readLatestTransactionNumber` + `waitForTransactionOutcome` (`transaction.ts:840-965`) →
UCPath submit tasks' receipt capture. ServiceNow redirect-URL parse (`fill-form.ts:140-162`) →
ServiceNow receipt. oath-upload `submitAttempted` + `hasUnverifiedPriorSubmit` + `findPriorTicketFor
Session` (`handler.ts:309,388-454`) → the generalized fence + recovery probe. Separations
`findExistingTerminationTransaction` + pending sweep → the UCPath termination probe. **Kuali and
OnBase must gain a real post-submit read-back** — the one place the port is a genuine addition, and
the design forces it (their submit tasks cannot compile a passing receipt schema otherwise).

---

## 3. TOP GAP 2 — Guard & Test Architecture SSOT

**Thesis: "same quality umbrella from day one" (charter non-negotiable) is only real if ONE doc owns
HOW every doc's adversarial-review guard actually lands in `tests/unit/architecture/`, extends the
23 existing ratchets to `temp_src`, and adds the two safety-critical guards no single doc can own —
the dry-run *composition* guard and the fill↔submit *pairing* guard, which today do not exist even
in spec (no architecture guard references `dryRun` at all).**

### 3.1 What exists today (the port inventory)

23 architecture guards, two mechanism families: **grep-ratchets with `Record<file,{count,reason}>`
allowlists** (`fail-loud-catch-default`, `wait-for-timeout-allowlist`, `inline-selectors-workflows`,
`nullish-literal-data-fallback`) and **registry-parity coverage guards** that side-effect-import the
kernel `getAll()` registry and diff it against hand-lists (`instance-labels-coverage` vs
`INSTANCE_LABELS` at `session-events.ts:395`; `queue-row-kind-coverage` vs `SUBJECT_TO_KIND` at
`queue-row-kind.ts:78`; `runtime-policy-coverage`, `archetype-coverage`). Plus the 2026-07-17
`gate-coverage.test.ts` **meta-guard** that guards the gates themselves (asserts `typecheck:all`
runs both `tsc` programs — the dashboard silently drifted 100 type errors while un-gated).

### 3.2 The two guards that must exist and don't (the safety core)

The charter's entire dry-run safety model rests on **composition** ("the submit is simply absent" —
§a). Today that is enforced only at *runtime* (the mutation-primitive throw) and by two tests
(`separations/dry-run.test.ts` + the live `separations-dryrun.test.ts` asserting `skipped` rows).
Nothing proves *statically* that a dry-run composition is submit-free. Two new guards close this:

- **`dry-run-composition-submit-free.test.ts`.** For every descriptor, compute the dry-run
  composition (doc 02's node list with submit tasks excluded) and assert **no reachable task has
  `effect:"mutate"` + `dryRun:"unsupported"`, and no reachable task imports a `stores/common/
  mutation.ts` primitive.** Keys off the closed contract `effect` + the closed mutation-primitive
  registry — not text heuristics. This makes charter §a a compile-adjacent invariant.
- **`fill-submit-pairing.test.ts`.** Every form-filing `effect:"mutate"` submit task must have, in
  the same workflow, a preceding `effect:"read"` fill task, OR an allowlisted justification (a
  genuinely atomic write). The closest existing analog is `i9-check-import-guard.test.ts` (proves
  mutation-exclusion for one workflow by import-allowlist) — this generalizes that shape to the
  fill↔submit invariant.

### 3.3 What replaces the ~10 coverage guards (descriptor SSOT crosswalk)

Doc 02 §1.4 defines ONE `descriptor-coverage.test.ts`. This doc owns the crosswalk that retires the
old parity guards:

| Old guard / hand-list | Fate under the descriptor |
|---|---|
| `instance-labels-coverage` + `INSTANCE_LABELS` | DELETED — label = `descriptor.sessionLabel ?? label` |
| `queue-row-kind-coverage` + `SUBJECT_TO_KIND` | subsumed — kind derived from `descriptor.inputSubject` in the one coverage test |
| `archetype-coverage`, `runtime-policy-coverage` | subsumed — shape/actions read from the descriptor |
| the two side-effect-import lists (themselves hand-lists mirroring `workflows.ts`) | DELETED — `DESCRIPTORS` is the import set |
| `gate-coverage` (meta) | **KEPT + extended** — also asserts each named `temp_src` architecture guard file exists and is registered in `test:architecture` (a guard-of-guards manifest, so this doc can't rot into a stale prose index) |

### 3.4 The TDD topology for `temp_src` (the "same quality umbrella", made concrete)

Four tiers, each with an owned home — this is what a rebuilt task/workflow gets TDD'd against:

1. **Pure-logic unit** — `task.impl.run({ input, ctx: fakeCtx })`. Doc 01 §7B's plain-object shape
   makes every task run unit-testable with a fake ctx; the `fakeCtx` contract is defined here.
2. **Contract/type** — every `example` parses (doc 01 guard #4); type-level tests (undeclared error
   codes fail `tsc`, D15; a mutate contract without a receipt fails the write-safety guard).
3. **Architecture ratchets** — the ported grep-ratchets, each glob extended to `temp_src/**` with a
   **ZERO allowlist for new `temp_src` code** and shrink-only entries for ported files (charter).
   The `Record<file,{count,reason}>` justification discipline is preserved verbatim.
4. **E2e stub lane + live lane** — the stub lane (`HRAUTO_E2E_STUBS`) migrates from
   `cloneWithScriptedSteps` to **happy-path derived from each contract's `example`** (D3), with the
   hand-scripted failure/cancel/parallel scenarios kept in the file-based hold/fail-gate mechanism
   (`e2e-gates/`). The live lane (`tests/live/`, Duo cleared by the enrolled WebAuthn credential,
   `dryRun:true` the only safety boundary) ports as-is.

### 3.5 Ownership + guard against my own proposal

Recommend a **new doc (10-guard-architecture)**. It is genuinely cross-cutting: every doc's §guards
section is a promise this doc turns into one non-duplicated, non-drifting suite. **Rot risk:** a
meta-guard doc becomes a stale index. **Guard:** §3.3's guard-of-guards manifest test — the doc
doesn't *list* guards in prose, it is pinned by a test asserting each named guard file exists and is
wired into `test:architecture`. **False-confidence risk** in the composition guard if
"mutation primitive" detection were heuristic — mitigated by keying off the closed `effect` union +
the closed `stores/common/mutation.ts` primitive registry.

---

## 4. TOP GAP 3 — The Clock (and the Config/Secrets domain it anchors)

**Thesis: "one source of truth for the time and the timelines" needs an owned, injectable Clock —
because the D8 freshness *safety* mechanism, trace-id time-of-day, fiscal rollover, and every span
timestamp all currently read one of 445 direct wall-clock calls, none testable, none single-sourced.
The same domain owns config precedence, per-system instance selection (a test-vs-production SAFETY
boundary), fiscal dates, and secret access.**

### 4.1 What exists today

- **No central clock.** 238 `new Date(` + 207 `Date.now(` = **445 direct reads**, zero abstraction.
  The one good pattern is `buildTraceId({ at })` (`queue-trace-id.ts:76-82`) — deliberately pure,
  takes the timestamp as a parameter — but **every production caller defeats it with `at: new Date()`
  inline** (`tracked-workflow.ts:229`, `run-one-item.ts:441`, `ocr/orchestrator.ts:404`, …). Local
  date-partition formatting is duplicated ad hoc in ≥4 places (`jsonl-core.ts:31`, `deletions/
  store.ts:13`, …), driving tracker filenames + cross-midnight merges. Injectability exists only as
  scattered private `now?:()=>number` params (`duo-webauthn.ts:580`, `identity.ts:154`, …).
- **Config half-owned.** `config.ts` + `settings/{types,store,schema}.ts` is a genuine single-source
  with `env > settings.json > default` precedence, BUT precedence is re-implemented per read-site
  (`process.env.X ?? SETTINGS.y`), the code-default is duplicated (config literal ↔
  `DEFAULT_OPERATOR_SETTINGS`, invariant hand-maintained at `types.ts:226`), several knobs escape the
  schema (`I9_APP_URL`, `CRM_SECTION_URLS`, direct `OCR_*` reads), and **URL overrides are
  process-global — you cannot target a test instance for one run and production for another.**
- **Secrets: one good choke, leaky edges.** SSO secrets funnel through `validateEnv`
  (`env.ts:33-49`); but `HRAUTO_DASHBOARD_LAN_PASSWORD` and the `.auth/` Duo private keys
  (`duo-webauthn.ts:37-38`) sit outside it, and `process.env` is read inline in ~15 files.
- **Fiscal dates are static, mirrored, and already stale** — `ANNUAL_DATES` literals
  (`config.ts:109-113`) + mirror in `types.ts` + a dated filename `i9ActionHistoryPath`
  (`config.ts:54-59`); `jobEndDate 06/30/2026` is already past (today 2026-07-17) with no rollover
  and no loud staleness signal.

### 4.2 The design

```ts
// temp_src/domain/clock.ts — the ONLY place new Date()/Date.now() may appear (grep-ratchet, §4.3)
export interface Clock {
  now(): Date; nowMs(): number;
  todayLocal(): string;          // YYYY-MM-DD for tracker partitioning — one impl, not 4 ad-hoc
  timeOfDayCode(at?: Date): string;   // HHMMSS for trace ids
}
export const systemClock: Clock;                 // reads the OS
export function fixedClock(at: Date): Clock;      // tests: deterministic freshness + trace ids
```

The executor (doc 05) holds the Clock and threads it into: the freshness walk (doc 02 §5.5 — a
**safety** computation now unit-testable), trace-id minting (feed the pure `buildTraceId(at)` from
`clock.now()` instead of inline `new Date()`), span timestamps (doc 03), and tracker partitioning
(one `todayLocal()`).

- **Config** — one resolver `resolve(key)` implementing `env > settings.json > default` ONCE (not
  per read-site), with the effective value + its **source** surfaced in Settings (port the read-only
  `.env` Credentials transparency the old system already shows), killing the silent-shadowing hazard.
- **Per-run instance selection (safety).** `RunEnvelope.instance?: Partial<Record<SystemId,"prod"|
  "test">>` (doc 02), defaulting **loudly to production**, surfaced on the run card and **recorded in
  every span** — so a run against a test instance vs a real production submit is distinguishable in
  the audit trail (gap 5) and structurally impossible to confuse. Replaces the process-global URL
  override.
- **Fiscal dates as fail-loud data** keyed by fiscal year, computed via the Clock: a missing entry
  for `FY{clock.now().fiscalYear}` **throws** "no ANNUAL_DATES configured for FY2027" instead of
  silently using a stale literal.
- **Secrets** — one `requireSecret("UCPATH_PASSWORD")` that throws loud if unset (never `?? ""`);
  the `.auth/` + Duo credential handling gets one owned home; doc 05's session-pool login reads
  through it.

### 4.3 Guard + adversarial self-review

`clock-single-source.test.ts` — `new Date(` / `Date.now(` banned in `temp_src/` outside
`domain/clock.ts` (shrink-only allowlist for ported leaves, exactly the `wait-for-timeout` pattern).
`process.env.` banned outside the config/secrets accessor. **Rot risk:** a ported leaf calls
`new Date()` — caught by the ratchet + shrink-only allowlist. **Wrong-default risk** on instance
selection (test when the operator meant prod, or worse) — mitigated by the loud production default +
the always-recorded audit field, so a mistake is *visible*, never silent. **Precedence-shadowing
risk** (an env var masking a settings.json the operator edited) — mitigated by Settings showing the
effective value AND its source.

---

## 5. PARTIALs — what a doc claims to own but under-specifies

- **Doc 02 §OQ2 (crash-write probe).** Doc 02 *claims* checkpoint/resume but explicitly leaves the
  disambiguating probe as an optional open question. That is the exactly-once hole — gap 1 closes it.
- **Doc 01 mutate output.** §6.2 specifies the honest *not-submitted* value but does NOT require an
  honest *proven-submitted* receipt. A mutate output can today be `{ submitted:true }` with no
  verifiable proof — gap 1's `receipt` field closes it.
- **Doc 02 §5.5 freshness depends on `now`** but no doc owns the clock — the safety mechanism rests
  on an unmockable, unowned input (gap 3).
- **Doc 05 §3.3 browser-health ladder** is referenced as "the verdict ladder ports as pool behavior"
  without enumerating the verdicts (`ok/soft/wedged/expired/closed/dead`) or the refresh→reopen→
  failed rungs. It is load-bearing for real long-running batches; doc 05 should enumerate it (gap 11).
- **Doc 03 §OQ1 retention** leaves audit longevity open (proposes 30d spans). For a compliance HR
  tool the *receipts* (gap 1/5) need a retention **floor** that survives `clean-tracker` (which
  prunes at 30d, `clean-tracker.ts:155`) — the operational trace and the audit ledger must have
  different lifetimes.
- **Doc 02 §1.4 / doc 03 §6 guards are listed per-doc** but no doc owns the suite or the meta-guard
  that keeps them registered (gap 2).

---

## 6. Adversarial self-review of my own proposals (cross-cutting)

- **Gap 1's idempotency probe is itself a read that can lie.** A false "already-present" skips a
  needed write (missing transaction); a false "not-present" double-submits. This re-introduces the
  exact `fail-open → SUBMIT` hazard if sloppy. **Guards:** the probe is `maxAgeMs:0` always-live
  (never a stale checkpoint); its key is exact-match on a stable natural key (EID ⊕ type ⊕ effdt);
  an ambiguous (>1) or *failed* probe parks `needs-operator`, never guesses; `fail-loud-catch-default`
  already bans `catch { return notFound }`. The probe's failure must be distinguishable from
  "found nothing" (charter's core rule).
- **Gap 2's guards could add ceremony that slows migration.** A pairing guard that's too strict
  blocks legitimate atomic writes. **Guard:** the allowlist-with-justification escape hatch (same as
  every existing ratchet) — a genuinely atomic write is argued once in a `{ reason }` entry, not
  banned. The composition guard keys off closed unions, so it can't false-positive on text.
- **Gap 3's Clock threaded everywhere risks bypass.** Someone calls `new Date()` in ported code.
  **Guard:** the grep-ratchet with shrink-only allowlist — the ported count only ever decreases,
  and new `temp_src` code has zero tolerance.
- **Meta-risk: three new docs is more surface to keep coherent** (the charter warns against multiple
  competing plans). **Guard:** each of the three is a *contract* doc owned in the D1 matrix, and the
  master plan (doc 07) *references* them without redefining — the same discipline docs 01–05 already
  follow. Gap 1's execution references doc 02 §5; gap 3's clock is consumed by 02/03/05 by reference.
  None redefines a sibling's owned concept.

---

## 7. Open questions for the operator / orchestrator

1. **Kuali & OnBase receipts.** Gap 1 forces a post-submit read-back to prove a filed doc for the
   two systems that capture nothing today — is a live-verifiable "filed document" read-back
   achievable in Kuali (which deliberately removed its error detection as false-positive-prone) and
   OnBase, or does one of them need a documented `{ reason }` allowlist as genuinely
   unverifiable-by-page (and therefore always `needs-operator`-confirmed)?
2. **Idempotency probe cost vs. speed (tension with doc 05).** A mandatory always-live pre-write
   probe adds one UCPath round-trip per submit on the write tab — acceptable given the sleep-tax
   savings, or should the probe be skippable for a fresh run with zero prior attempts (risky —
   re-opens the crash window on the *first* attempt)?
3. **Audit ledger retention floor.** Should `write.committed` receipt events live in a separate,
   never-pruned, append-only (ideally hash-chained) ledger — distinct from the 30-day-pruned
   operational `spans/`/`notes/` — and if so, is local unsigned JSONL sufficient or does compliance
   want tamper-evidence?
4. **Per-run test-vs-production instance (gap 3).** Is per-run instance selection worth the
   RunEnvelope + audit-field cost now, or is process-global URL override (today's behavior)
   acceptable until a workflow genuinely needs mixed targeting?
5. **Three new docs vs. annexes.** Own write-safety, guard-architecture, and clock/config/secrets as
   three new numbered docs (clearest ownership), or fold the clock/config/secrets into a doc-01 annex
   and the guard-architecture into doc 02/03 to keep the doc count down? The D1 matrix prefers one
   owner per concept — but the master plan's "no competing plans" prefers fewer docs.
