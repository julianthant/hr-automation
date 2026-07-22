# 09 — Write-Safety: Exactly-Once for Real HR Mutations

Status: **Phase 0 revised design — external-review corrections integrated 2026-07-21.** Conforms to `00-charter.md` (§1a fill/submit
split, §13 write-safety + the binding operator answers of 2026-07-18, §b migration questionnaire),
the reconciliation memo `04-reconciliation.md` (D26/D30–D33/D43/D44), and the top finding of the gap audit
`08-foundation-gap-audit.md` (this doc turns that BLOCKER into an owned contract). Code lands in
`temp_src/`.

This is the highest-stakes doc in the rebuild. It governs whether a real, sometimes irreversible HR
transaction (a UCPath termination, a ServiceNow ticket, a Kuali save, an OnBase filing) is filed
**exactly once** and reported **done only when we are sure it landed**. The operator's non-negotiable
(charter §13, 2026-07-18): *"you have to be very sure they were completed"* — completion is
**FAIL-CLOSED everywhere**: an unknown or unverifiable result is **never** treated as done.

## Ownership (D1 — this doc owns / this doc references)

| This doc **owns** (siblings reference, never redefine) |
|---|
| The **write-safety contract** — the required `WriteSafety` field on a commit task, typed proof schema for every completion kind, idempotency probe/key, and fail-closed verdict protocol |
| The **kernel write sequence** — resolve/probe → prepare → fence → external commit → proof → durable commit, and its ordering invariant |
| The **crash-window fence** (`write_intents` SQLite table) and the **crash-recovery replay** (recovery-probe branching) |
| Typed, intent-generation-locked operator resolution for parked writes (confirmed present/absent; no generic Done/Retry) |
| **Double-submit prevention** — idempotency key derivation + the per-workflow probe-policy knob (§b) |
| The **immutable receipt/transaction ledger** — schema, location, never-pruned guarantee, hash-chain, what one entry records |

| This doc **references** (owner) |
|---|
| `PrepareTaskContract`/`CommitTaskContract`, transaction-scoped dry-run composition, `MutationCapability`, error taxonomy, freshness, stores → **doc 01** |
| Transaction nodes, gates + `PARKED(needs-operator)`, checkpoint provenance/fingerprints, declared dependency DAG, `RunEnvelope` → **doc 02** |
| Span/note wire schema, `.tracker/` storage layout, SQLite system-of-record vs projection split (D14), completion fan-out union → **doc 03** |
| The injectable Clock (all timestamps), per-run test/prod instance selection, the config/secrets domain → **doc 11 (clock/config/secrets)** |
| The fill↔submit pairing guard + dry-run composition guard → **doc 10 (guard-architecture)** |

Amendments at sibling seams (each is a one-owner-per-concept addition, not a redefinition):
- **Doc 01 §2.2** — `CommitTaskContract` requires `writeSafety`; its shape is owned here.
- **Doc 01 §6.2** — the mutation primitive requires both `CommitTaskCtx.mutation` and an open fence.
- **Doc 02 §5.6 #2 / §OQ2 (per D17 — doc 02 OWNS and adds these).** "Crash-mid-write always parks"
  becomes **probe-then-park**, and the transaction node gains required `probePolicy` and
  `probeToFenceMaxMs` fields.
  Doc 02 owns those fields; this doc owns only the recovery-probe *mechanism* they invoke.
- **Doc 03 §2.1 / §2.3 (per D21 — doc 03 OWNS and adds these).** The `ledger/` dir (never-pruned
  retention floor) and the `write_intents` **system-of-record** table live in doc 03's storage
  layout; this doc owns their *shape/semantics*, not their placement in the `.tracker/` tree.

---

## 0. Grounding — what exists today (the port inventory, real code)

Every row below is live-verified leaf knowledge the charter forbids re-deriving. It ports, wrapped.

| System | Confirmation today | Grounding (file:line) | Verdict |
|---|---|---|---|
| **UCPath** | Strong. `waitForTransactionOutcome` polls {error banner} vs {success marker}, error wins ties, and **RETURNS `"timeout"`** when neither appears; its caller **`clickSaveAndSubmit` then throws** *"…PeopleSoft's outcome is unknown, refusing to report success."* (`transaction.ts:855-859` — the throw is the caller's, not the poller's). T-number scraped by a second nav that re-finds the row **by EID (Person ID), not name**, and parses `Transaction ID: T…`; readback failure returns `""` which callers MUST treat as "couldn't read back," never "no transaction." | `ucpath/transaction.ts:42-66, 835-861, 919-985`; oath sibling `oath-signature/enter.ts:281-284` | Ports → `receipt` capture |
| **ServiceNow** | Medium. Only truly-positive receipt: `waitForURL` for a changed URL containing `number=`, parse `/^HRC\d{6,}$/`; **throws** *"no number= param in post-submit URL"* if absent. | `oath-upload/fill-form.ts:140-173` | Ports → `receipt` capture |
| **Kuali** | **NONE.** `clickSave` = click + `networkidle(15s)` + 2s sleep + `log.success`. Error detection was **deliberately removed** as false-positive-prone (matched benign DOM). Weakest of all. | `kuali/navigate.ts:634-652`; `kuali/CLAUDE.md` gotchas + 2026-04-10 lesson | **Must EARN a `save-verify` read-back** |
| **OnBase** | **NONE (negative only).** Success = the import postback landed on a page that is *not* a recognized ASP.NET error (`authenticated` OR `unknown` both pass). No positive "filed" signal. One-app-session-per-identity: never two logins at once. | `onbase/handler.ts:208-217`; `onbase/page-state.ts:149`; `onbase/LESSONS.md:137-176` | **Must EARN an `upload-verify` read-back, or allowlist unverifiable→always-park** |
| **Idempotency** | No keys, live-page probes, biased **fail-open→SUBMIT**. Onboarding `findExistingHireTransaction` (by name, hires have no EID) skips only on a high-confidence HIR/REH+effdt match; *"a false skip would silently never hire the real person, which is worse than the probe-guarded double-submit."* Separations `findExistingTerminationTransaction` (EID+effdt+"Terminatn"); the REAL guard is the **date-agnostic** `deletePendingTransaction` sweep that clears ALL in-progress Terminat rows for the EID. | onboarding `workflow.ts:488-521`; separations `steps/ucpath-transaction.ts:83-104`, `transaction.ts:1167`; `control/CLAUDE.md:36` ("no idempotency cache") | Ports → probes, **verdict widened to 3-valued** |
| **Crash window** | **oath-upload ONLY.** `submitAttempted:"true"` marker stamped **before** the POST (durable via the next `step=submit` emit); `hasUnverifiedPriorSubmit` refuses+escalates on recovery; `findPriorTicketForSession` (recorded ticket wins). SQLite fast-path + JSONL fallback so a retry's own rows can't mask a prior crash. | `oath-upload/handler.ts:249,273,309,388-454` | **Generalized into the kernel fence + recovery probe** |

**The two incidents this layer exists to make impossible:**
- **Duplicate person** (`ucpath/LESSONS.md:209-216`, 2026-07-01): a single dialog probe read too
  early classified a rehire as a new hire ⇒ onboarding created a duplicate person.
- **Wrong-person termination `T002173685`** (`separations/CLAUDE.md`, 2026-06-29): a name-search
  override date-matched a *different* career employee and filed a real termination against him —
  still needing manual reversal. **Honest scope:** that was a *wrong-data* error, not a duplicate.
  Write-safety's idempotency prevents **double-filing**; **wrong-data** is prevented by doc 02's
  freshness (D8) + the **identity-approval gate** (`domain/identity-approval.ts`, now a real gate,
  not a "return done + park data"). Write-safety's contribution to `T002173685` is narrower but real:
  the receipt is **recorded in the immutable ledger**, so a wrong filing is attributable and findable
  for reversal instead of buried in row snapshots.

---

## 1. The one-sentence thesis + the fail-closed principle

> **Every `effect:"commit"` task declares typed proof-of-landing (a receipt, saved-state proof, or
> uploaded-artifact proof)
> and an idempotency probe; the kernel drives a fixed resolve/probe → prepare → fence → external
> commit → proof → durable-commit
> sequence around it; and every "is it done / is it already there?" question is answered by a
> FOUR-state verdict where `unknown` blocks — never a boolean that lets uncertainty read as
> success.**

The single mechanism that makes fail-closed structural is the **`ProbeVerdict`**: a probe or verify
read cannot return `true/false`. It returns `present | absent | ambiguous | unknown`. `unknown` and
`ambiguous` route to `PARKED(needs-operator)` — never to a submit and never to a "done." This
directly dissolves today's fail-open dichotomy (onboarding: *"skip and never hire" vs "blind
double-submit"*): the third answer is **park and let the operator decide**, which is strictly safer
than both.

---

## 2. The write-safety contract

### 2.1 The `WriteSafety` field (owned here; attached to doc 01's `CommitTaskContract`)

```ts
// temp_src/domain/contracts/write-safety.ts — bundle-safe: imports zod + TaskId ONLY (D3 guard)
import { z } from "zod";
import type { TaskId } from "./base.js";

/** Fail-closed verdict factory. `present` cannot exist without proof of the exact schema
 * required by the commit's completion arm; there is deliberately no untyped/boolean form. */
export function probeVerdictSchema<Proof extends z.ZodType>(proofSchema: Proof) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("present"), proof: proofSchema }),
    z.object({ state: z.literal("absent") }),
    z.object({ state: z.literal("ambiguous"), matches: z.number().int().min(2) }),
    z.object({ state: z.literal("unknown"), reason: z.string() }),
  ]);
}
export type ProbeVerdict<Proof extends z.ZodType> =
  z.output<ReturnType<typeof probeVerdictSchema<Proof>>>;

interface ProofCheck<Out extends z.ZodType, Proof extends z.ZodType> {
  /** The same parser validates normal commit output and recovery-probe backfill. */
  proofSchema: CanonicalJsonSchema<Proof>;
  proofFromOutput: (output: z.output<Out>) => z.input<Proof>;
  proofFromPresentProbe: (
    verdict: Extract<ProbeVerdict<Proof>, { state:"present" }>,
  ) => z.input<Proof>;
  /** Recovery/preflight-present must reconstruct the transaction node's full typed output; proof
   * alone is not a substitute for fields downstream nodes consume. Both schemas are parsed. */
  outputFromProof: (proof: z.output<Proof>) => z.input<Out>;
}

/** UCPath / CRM / ServiceNow — irreversible submits capture a verifiable receipt. */
export interface ReceiptCheck<Out extends z.ZodType, Proof extends z.ZodType>
  extends ProofCheck<Out, Proof> {
  kind: "receipt";
}
/** Kuali — typed saved-state proof, not merely a boolean/present verdict. */
export interface SaveVerifyCheck<Out extends z.ZodType, Proof extends z.ZodType>
  extends ProofCheck<Out, Proof> {
  kind: "save-verify"; verify: TaskId;
}
/** OnBase — typed artifact proof from a positive read-back. */
export interface UploadVerifyCheck<Out extends z.ZodType, Proof extends z.ZodType>
  extends ProofCheck<Out, Proof> {
  kind: "upload-verify"; verify: TaskId;
  /** Escape hatch (allowlisted + argued in doc 10): the page genuinely cannot prove landing. Then the
   *  submit ALWAYS parks needs-operator for manual confirmation — it never auto-reports done. */
  unverifiableByPage?: {
    reason: string;
    /** Must parse through proofSchema and exercise its operator-attestation discriminant. The
     * runtime replaces example values with the authenticated operator/Clock/evidence form. */
    operatorAttestationExample: z.input<Proof>;
  };
}
export type CompletionCheck<Out extends z.ZodType, Proof extends z.ZodType> =
  | ReceiptCheck<Out, Proof>
  | SaveVerifyCheck<Out, Proof>
  | UploadVerifyCheck<Out, Proof>;

export interface Idempotency<In extends z.ZodType> {
  /** A read task answering "is THIS exact transaction already present?" → ProbeVerdict. Runs
   *  pre-write AND on crash recovery. Declared with zero-age freshness (always live, never a stale
   *  checkpoint). Must resolve to a real effect:"read" task in the SAME store (guard §8). */
  probe: TaskId;
  /** The natural idempotency KEY — derived from STABLE business identity, NEVER row/position/index
   *  (the doc1/doc2 fix, §5). e.g. `${eid}|termination|${effectiveDate}`. Pure. */
  key: (input: z.output<In>) => string;
}

export interface WriteSafety<
  In extends z.ZodType,
  Out extends z.ZodType,
  Proof extends z.ZodType,
> {
  completion: CompletionCheck<Out, Proof>;
  idempotency: Idempotency<In>;
}
```

`CommitTaskContract<Id, In, Out, Proof, Codes>` requires
**`writeSafety: WriteSafety<In, Out, Proof>`**. There is
no optional escape hatch: even a naturally idempotent external write must declare its key, proof,
and probe. All three completion arms carry a nontrivial `proofSchema`; recovery and normal commit
use the same parser, and `outputFromProof` must reconstruct a value accepted by the commit output
schema for preflight-present/recovery paths. The kernel then wraps it in doc 02's discriminated
`TransactionOutcome`, so downstream code sees whether this run committed or found prior work.
Probe/verify tasks are separate reads in the same store. An
`unverifiableByPage` proof schema is a discriminated union with an `operator-attestation` arm
containing operator, confirmedAt, exact artifact/business identity, and a non-empty evidence note;
its example is guard-parsed. It may never be a bare boolean or generic “mark done.”

### 2.2 Per-system instantiation (three shapes, one mechanism)

```ts
// UCPath termination — receipt-bearing (ports transaction.ts:919-985 into ucpath/read-transaction-number)
writeSafety: {
  completion: { kind: "receipt",
    proofFromOutput: (o) => o.receipt,
    proofFromPresentProbe: (v) => v.proof,
    outputFromProof: (p) => ({ receipt: p }),
    proofSchema: z.object({ transactionNumber: z.string().regex(/^T\d{6,}$/) }) },
  idempotency: {
    probe: "ucpath/find-existing-termination",                 // by EID + effdt + "Terminatn"
    key:   (i) => `${i.emplId}|termination|${i.effectiveDate}` },
}
// ServiceNow ticket — receipt-bearing (ports fill-form.ts:140-173)
completion: { kind: "receipt", proofFromOutput: (o) => o.ticketNumber,
  proofFromPresentProbe: (v) => v.proof, outputFromProof,
  proofSchema: z.string().regex(/^HRC\d{6,}$/) }
// Kuali save — save-verify, NO receipt (operator §13)
completion: { kind: "save-verify", verify: "kuali/read-saved-document",
  proofFromOutput, proofFromPresentProbe, outputFromProof, proofSchema: KualiSavedStateProof }
// OnBase upload — upload-verify, positive read-back OR allowlisted unverifiable→always-park
completion: { kind: "upload-verify", verify: "onbase/read-filed-document",
  proofFromOutput, proofFromPresentProbe, outputFromProof, proofSchema: OnBaseArtifactProof }
```

Kuali and OnBase are the one place the port is a **genuine addition** (§10): their submit tasks
cannot instantiate a passing `completion` without a new post-write read-back, because today they have
none. That is by design — the contract *forces* proof to exist.

---

## 3. The kernel write sequence

The kernel drives a fixed six-beat sequence. It binds/parses the commit input first from workflow
input plus declared upstream outputs; commit input cannot depend on ephemeral prepare output. Beat ①
uses an ordinary read lease and releases it. Beats ②–⑤ use one uninterrupted exclusive transaction
lease, so a navigating probe can never destroy a staged form. Dry-run composes beat ② only and has
no executable preflight/fence/commit path or mutation capability. The impl author cannot reorder the
real-write beats.

```
① RESOLVE/PROBE → ② PREPARE → ③ FENCE → ④ EXTERNAL COMMIT → ⑤ PROOF → ⑥ DURABLE COMMIT
   read lease      transaction lease ───────────────────────────────┘    DB + outboxes
```

| Beat | What runs | What is DURABLE at end of beat | Fail-closed exit |
|---|---|---|---|
| **① Resolve + live probe** | From the already parsed stable commit input, derive the key and read the permanent `write_intents` row regardless of status/originating run. `committed` or `observed-present` ⇒ validate/reuse proof+typed output; `attempting` ⇒ recovery/owner check; `retryable` ⇒ eligible generation. Only an eligible unseen/retryable key may run the policy-controlled live probe, on a separate read lease. Record probe completion monotonic time. | one SQLite transaction records an unseen live `present` permanently as `observed-present`, checkpoints `TransactionOutcome{disposition:"already-present",proofSource:"live-probe"}`, advances run state, and enqueues its audit span—but **no write-ledger row** | invalid stored proof/output ⇒ corruption/park; attempting owner live ⇒ wait/fail loud; stale owner ⇒ recovery first; live `present` ⇒ typed no-click completion; ambiguous/unknown/throw parks |
| **② Prepare** | Acquire the context-exclusive transaction lease and run the prepare contract. The parsed commit input is already frozen; prepare output is preview/span data only. Retry may restart from beat ① on a fresh/reset lease before any fence. | no write intent | prepare failure/timeout ⇒ release poisoned/clean page; no external side effect to recover |
| **③ Fence** | Check `probeToFenceMaxMs`; if expired, discard staged state and restart at ①. INSERT the unseen key or CAS its `retryable` row to `attempting`, incrementing generation. Enqueue `write.attempting` in the span outbox in the same SQLite transaction. The permanent primary key is the same-key mutex. | durable intent + span outbox | elapsed probe ⇒ no click; CAS conflict ⇒ discard staged page/no click; no generic retry after a won fence |
| **④ External commit** | The external-write helper requires the unforgeable `MutationCapability` bound to the open intent generation. | live HR side effect | missing/mismatched fence capability ⇒ throw before click |
| **⑤ Capture / verify** | Extract `proofFromOutput` or run the verify read on the retained transaction page; every completion kind parses through its `proofSchema`. | proof remains in memory | absent/ambiguous/unknown/throw/schema failure parks; no arm can return unvalidated proof |
| **⑥ Atomic durable commit** | ONE SQLite transaction marks the intent committed and writes the schema-valid `TransactionOutcome` checkpoint, immutable ledger outbox row, terminal-span outbox row, and run state. JSONL ledger/span projectors run afterward. | all authorities/outboxes durable together | transaction failure leaves intent attempting and enters recovery; projector lag is repairable and never changes write outcome |

**Ordering invariant:** stable commit input and live probe exist before page preparation; the fence
transaction in ③ happens-before the click; the click happens-before proof validation; proof
validation happens-before the single ⑥ transaction. Ledger and span JSONL
are projections of durable outboxes, not additional commit beats. This generalizes oath-upload's
"marker durable before the POST" (`handler.ts:306-309`) into the kernel.

```sql
-- temp_src state.db — SYSTEM-OF-RECORD (D14: not rebuildable, not deletable). The crash-window fence.
CREATE TABLE write_intents (
  system          TEXT NOT NULL,   -- SystemId
  idempotency_key TEXT NOT NULL,
  workflow        TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  owner_run_id    TEXT NOT NULL,
  owner_attempt   INTEGER NOT NULL,
  generation      INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL CHECK(status IN
                    ('attempting','retryable','committed','observed-present')),
  origin          TEXT NOT NULL CHECK(origin IN
                    ('automation-attempt','external-observed')),
  fenced_at       TEXT,
  committed_at    TEXT,
  proof_json      TEXT,
  proof_schema_hash TEXT NOT NULL,
  output_json     TEXT,
  output_schema_hash TEXT NOT NULL,
  PRIMARY KEY (system, idempotency_key)
);

CREATE TABLE write_attempts (
  system TEXT NOT NULL, idempotency_key TEXT NOT NULL, generation INTEGER NOT NULL,
  run_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('attempting','retryable','committed','observed-present')),
  started_at TEXT NOT NULL, ended_at TEXT,
  resolution_json TEXT,             -- typed operator/recovery evidence; never overwrites history
  PRIMARY KEY (system, idempotency_key, generation)
);

CREATE TABLE durable_outbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, aggregate_key TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL, projected_at TEXT
);

CREATE TABLE ledger_heads (
  system TEXT NOT NULL, ledger_date TEXT NOT NULL,
  expected_seq INTEGER NOT NULL, expected_hash TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL,
  PRIMARY KEY (system, ledger_date)
);
```

Committed and externally-observed-present keys remain in the primary-key table forever. A later run with the same business key
parses and reuses the stored proof; it cannot create a second fence merely because the earlier row
is already satisfied. `observed-present` blocks a click but writes no ledger entry: discovering a
transaction is not evidence this automation filed it. There is no operator action that reopens a committed key. Normal recovery from a
proven-absent click changes the same row to `retryable` and increments its generation on the next
fence rather than deleting history. If an externally reversed transaction must legitimately be
filed again, its input carries a distinct audited correction/revision identity that derives a new
natural key; "void the fence and click again" is not an operation.

---

## 4. Crash-window recovery (the exactly-once guarantee)

**The guarantee, stated precisely:** for any real commit, after a crash at *any* point recovery
selects exactly one of three outcomes, and **never blindly double-files**:

1. **The write landed** (crash anywhere after ④) → recovery's probe returns `present` → the kernel
   runs `completion.proofSchema.parse(completion.proofFromPresentProbe(verdict))`, then
   `commit.output.parse(completion.outputFromProof(proof))` — the SAME validation
   beat ⑤ parsers run; a `present` proof is never trusted blind. On parse **success** it **backfills** the
   full typed `TransactionOutcome{disposition:"committed",proofSource:"recovery-probe"}`, marks the existing attempted intent committed, atomically
   enqueues ledger/span outboxes, and completes `done` (no second
   submit). On parse **failure** it **parks `needs-operator`** (a `present` we cannot validate is
   indeterminate, not done). There is **NO path to `done` with unvalidated proof—recovery
   included.**
2. **The write never landed** (crash between ③ and ④, or a genuinely-not-sent click) → recovery's
   probe returns `absent` → the same intent becomes `retryable`; history is retained and the next
   attempt CAS-fences a new generation of that key.
3. **Indeterminate** (probe returns `ambiguous`/`unknown`, or throws) → `PARKED(needs-operator)` with
   a legible message naming the key, the system, and the match count — the operator verifies in the
   target system and uses one of the typed resolutions below. Never a guess.

**Recovery replay (resolves doc 02 §OQ2 — replaces "always park"):** on resume, the kernel first
scans `write_intents` for the resuming `(workflow,item_id,step_id)`. If it finds a row with
`status:"attempting"` and no `committed`, it **re-runs `idempotency.probe(key)` FIRST** (before any
`startAt` node logic) and routes on the verdict per 1/2/3 above. Only after the probe resolves does
normal resume proceed. A read node with no fence auto-resumes as today (worst case: a repeated
read). This reads durable state from SQLite (system-of-record), never post-crash JSONL, mirroring
oath-upload's SQLite-fast-path recovery (`handler.ts:427-429`).

### 4.1 Parked-write resolution is typed and intent-scoped

A parked write does not inherit the queue's ordinary Done/Retry actions. The kernel exposes exactly
two intent-scoped resolutions, both requiring the current intent generation and an optimistic-lock
version so a stale browser action cannot race recovery:

1. **Confirmed present.** The operator supplies the exact business/artifact identity and proof. It
   parses through the same `completion.proofSchema`; `unverifiableByPage` uses the schema's typed
   `operator-attestation` arm. Success runs the same atomic beat ⑥ (intent committed + proof
   checkpoint + ledger/span outboxes + run state). Parse failure changes nothing.
2. **Confirmed absent.** The operator supplies a non-empty evidence note after checking the target
   system. SQLite records `{operator, confirmedAt, evidence, priorGeneration}` in `write_attempts`
   and changes the same permanent intent to `retryable`; only the next CAS may create a generation.
   It never deletes/reopens committed history and does not itself click.

Cancel/delete may hide or cancel the run but cannot alter the intent. There is no third “force done”
or “retry anyway” endpoint. Every resolution emits an audited note and is covered by authorization,
schema, stale-generation, and double-click tests.

---

## 5. Double-submit prevention

**Idempotency key from stable identity, never position.** The `key` function takes the parsed
workflow-derived input and returns a natural business key: `${eid}|termination|${effectiveDate}`,
`${sessionId}|${pdfHash}` (oath-upload today), `${eid}|hire|${jobCode}|${effdt}` (onboarding — note
hires have no EID pre-hire, so the key uses name+effdt+jobCode, the same fields
`findExistingHireTransaction` matches on). It **never** incorporates run position, attempt number,
array index, or the OCR fan-out index — that is the doc1/doc2 (E2E-015) shared-id fallback, banned in
the fan-out (`buildFanOutItemIdResolver`) and banned here (§8). Two runs for the same
person+type+date derive the same key, so beat ① sees the first run's committed intent and refuses to
double-file.

**Two probe kinds are distinct and both port** (separations taught us the difference):
- The **idempotency probe** reads *processed/filed* transactions (a committed `T…` exists) —
  `findExistingTerminationTransaction` keyed EID+effdt+"Terminatn".
- The **date-agnostic pending sweep** (`deletePendingTransaction`, `transaction.ts:1167`) is a
  *commit cleanup* that deletes ALL in-progress unprocessed Terminat rows for the EID regardless of
  effdt — it catches a stale prior attempt carrying a *different* computed effdt that the date-keyed
  probe misses. It ports as its own `ucpath/clear-pending-terminations` transaction composed BEFORE
  termination (it has its own durable key and typed proof: deleting nothing is a validated no-op;
  deleted row identities are its proof).

**The per-workflow probe-policy knob (charter §b — decided at migration, NOT defaulted here).** Beat
① (the *pre-write* probe) is governed by a per-workflow knob; the *recovery* probe (§4) is always on
regardless.

```ts
// on the transaction node (doc 02 owns the field; semantics owned here)
probePolicy: "always" | "retries-and-recovery-only";   // REQUIRED — no default
probeToFenceMaxMs: number;                              // REQUIRED, >0 — migration-justified
```

- `"always"` — probe before every submit (one extra live read per submit; safest; closes the crash
  window even on the first attempt).
- `"retries-and-recovery-only"` — may skip only the live-page probe when the durable key has never
  existed. Durable lookup is never skipped, committed keys are never exempt, and retries/recovery
  always probe. The trade-off is failure to notice an older external transaction absent from this
  automation's ledger, not permission to repeat one already committed here.

Both fields are **required** (compile error if omitted on a transaction), which forces the §b
migration question to answer policy and maximum preflight age per workflow. There is **no hardcoded
default**. The Clock's monotonic time measures probe completion → fence; expiration discards the
prepared page and restarts at preflight, never clicks on an over-age result.

---

## 6. The immutable receipt / transaction ledger

**Purpose (operator §13):** an immutable record of what real transactions were actually filed, **never
pruned** — it outlives doc 03's decided base retention (spans 30d / notes 7d, D21) and the
`clean-tracker` sweep.

```ts
// temp_src/domain/ledger.ts — the append-only at-rest entry shape.
// Beat ⑥ writes its unsequenced payload to durable_outbox; the projector adds seq/prevHash.
export interface LedgerEntry {
  outboxId: string;               // immutable DB identity; projector idempotency key
  seq: number;                    // assigned transactionally by the serialized projector
  prevHash: string;               // sha256 of the previous entry's canonical JSON ("" for seq 0)
  workflow: string;
  itemId: string;
  system: string;                 // SystemId — ucpath | crm | servicenow | kuali | onbase
  idempotencyKey: string;         // the natural key (§5) — dedupe + audit join
  proof: JsonValue;               // canonical JSON, already parsed by the completion proof schema
  proofSchemaHash: string;
  completionKind: "receipt" | "save-verify" | "upload-verify";
  proofSource: "normal-output" | "recovery-probe" | "operator-attestation";
  runId: string; traceId: string; attempt: number;
  operator: string;               // from the config/secrets domain (doc 11), never fabricated
  instance: "prod" | "test";      // resolved run snapshot (doc 11)
  configFingerprint: string;
  dryRun: false;                  // real writes only; a dry run composes no submit, so writes NO ledger entry
  fencedAt: string;               // durable instant before the click
  confirmedAt: string;            // proof accepted; may be later after recovery/manual confirmation
  externalOccurredAt?: string;    // only when the external proof itself supplies a trustworthy time
}
```

- **Location:** `.tracker/ledger/<system>-<YYYY-MM-DD>.jsonl` (doc 03 §2.1 adds the dir). JSONL so the
  operator greps it; per-system+day partition so `grep 10694136 .tracker/ledger/ucpath-*.jsonl`
  answers "what did we file for this person?" across time.
- **Never pruned (retention floor):** `clean-tracker` (which prunes `spans/` at 30d and `notes/` at
  7d — doc 03's decided base retention, D21) skips `ledger/` unconditionally — a ratchet guard fails
  if any prune path can reach `ledger/`. This is the "immutable transaction ledger, never pruned" of
  operator §13. The never-pruned floor sits above a *settled* number (D21), not a guessed one.
- **Serialized projection.** Executors never append the ledger file. Beat ⑥ writes a unique ledger
  outbox row. One projector holds a SQLite lease for `(system,date)` and processes exactly one row:
  it verifies the anchored file tail, derives `seq/prevHash`, appends one canonical line, fsyncs, then
  CAS-updates `ledger_heads` and marks that outbox projected in one SQLite transaction. A crash after
  append but before the CAS leaves the file exactly one known `outboxId` ahead; restart validates and
  adopts that line instead of appending it twice. A torn/unrecognized tail is truncated only to the
  anchored `expected_bytes` after preserving a corruption artifact and raising an alert. Multiple
  executors therefore cannot fork a chain, and the DB/file seam has an explicit recovery protocol.
- **Hash-chain + durable tail anchor.** Each entry carries `seq` + `prevHash`; SQLite table
  `ledger_heads(system,date,expected_seq,expected_hash,expected_bytes)` is the independent expected tail. A
  `cli ledger verify` compares the file to that anchor, so editing, interior deletion, record-boundary
  tail truncation, and whole-file loss are detectable. Without this anchor a valid-prefix tail
  truncation would be invisible. This is tamper-evidence, not tamper-proof: a local attacker who
  rewrites both the DB and file coherently is out of scope for a single-operator tool. It is the right
  altitude: enough to trust the audit trail, no HSM ceremony. Escalation to signed/anchored is a
  documented future option (§13 Q3), not built now.
- **Projection is idempotent** by `outboxId`. Recovery audits committed intents against ledger and
  terminal-span outboxes, creates only missing outboxes in SQLite, then lets projectors catch up.
- **One entry = one filed transaction.** The ledger is the durable superset of the `write.committed`
  span events (gap-audit gap 5: "receipts ARE the ledger"). It records a confirmed automation
  attempt, not a claim that `confirmedAt` equals the external filing instant. A preflight probe that
  merely discovers an existing external transaction produces `write.skipped-existing` audit state
  and no ledger entry.

---

## 7. Fail-closed everywhere — every place `unknown` could leak into `done`, and its exit

The operator's core requirement. Exhaustive:

| # | Where "unknown" could become "done" | Fail-closed exit |
|---|---|---|
| 1 | Pre-write probe (①) can't determine presence | `unknown` verdict ⇒ `PARKED(needs-operator)` — never submit |
| 2 | Pre-write probe finds >1 match | `ambiguous` ⇒ `PARKED` — never guess which is "the" transaction |
| 3 | Probe read **throws** (page/net error) | wrapped as `unknown` (a failed check ≠ "found nothing" — the charter catch-swallow ban) ⇒ `PARKED` |
| 4 | Receipt read-back returns `""` (UCPath) / no `number=` (ServiceNow) | missing/empty receipt ⇒ `PARKED("clicked, cannot prove it landed")` — mirrors today's "refusing to report success" throw |
| 5 | Captured proof fails its `proofSchema` | schema-fail ⇒ `PARKED`, never `done{committed:true}` |
| 6 | Kuali `save-verify` can't confirm the save | any verdict ≠ `present` ⇒ `PARKED` |
| 7 | OnBase `upload-verify` can't confirm the filing | any verdict ≠ `present` ⇒ `PARKED`; `unverifiableByPage` allowlist ⇒ **always** `PARKED` for manual confirm (never auto-done) |
| 8 | Crash mid-write, recovery probe indeterminate | `ambiguous`/`unknown`/throw ⇒ `PARKED`; `present` ⇒ backfill-done only after the arm's `proofSchema`; `absent`→same-key retry generation |
| 9 | A commit `run` returns success with no proof | kernel rejects at ⑤ ⇒ `PARKED` |
| 10 | The mutation primitive fired without a fence (a mis-authored submit) | primitive throws (④) — corruption, loud |
| 11 | dry-run: no submit composed at all (charter §1a) | write-safety never engages; nothing to make done — clean, no leak |
| 12 | Live probe aged while the form was prepared | `probeToFenceMaxMs` expires ⇒ discard page and restart at preflight; no fence/click |
| 13 | Operator clicks a stale/generic Done or Retry on a parked write | those actions do not exist; present proof/absent evidence endpoints require intent generation+version and fail on conflict |

The unifying rule: **only schema-valid proof plus schema-valid reconstructed/normal transaction
output yields `done`; only an actual fenced automation attempt yields a write-ledger entry. Every other outcome —
absent-after-click, ambiguous, unknown, throw, empty — parks or retries.** A boolean probe would
collapse #1/#3/#8 into "false ⇒ proceed"; the `ProbeVerdict` type makes that collapse
*unrepresentable*.

---

## 8. Mechanical guards (fail-loud ratchets, `npm run test:architecture`)

- **`write-safety-contract.test.ts`** — every `effect:"commit"` contract MUST declare write safety;
  no allowlisted escape hatch. Every completion arm has nontrivial `proofSchema`, normal-output and
  recovery-probe extractors, `outputFromProof`, and fixtures proving normal/recovery/preflight-
  present paths parse the same proof and commit-output schemas and yield the correct discriminated
  `TransactionOutcome`.
- **Probe/verify resolution** — `idempotency.probe` and any `save-verify`/`upload-verify` `verify`
  TaskId resolve to a real `effect:"read"` task in the **same store**, whose output is (or extends)
  `ProbeVerdict`, whose contract declares zero-age freshness. Table-driven over the store index.
- **Fence-before-click** — a unit fixture asserts the `write_intents` SQLite commit is observed
  before the mutation primitive is invoked; the primitive throws when invoked with no open fence.
- **Same-key sequential + concurrent dedupe** — fixtures cover two simultaneous starters and a
  later fresh run after the first committed. Both reuse/block on the permanent primary-key intent;
  neither can create a second fence/click. An unseen live `present` becomes `observed-present`,
  produces typed output but no ledger outbox, and remains permanently click-blocking.
- **Crash-recovery** — a fixture injects a `write_intents{status:"attempting"}` with no `committed`
  and asserts the recovery probe runs FIRST and routes present→(schema-parse then)backfill /
  present-with-receipt-failing-schema→park (D19) / absent→retry / unknown→park (four cases pinned).
- **Atomic outbox + ledger integrity** — crash injection at every subpoint of beat ⑥ proves the
  intent/checkpoint/ledger-outbox/span-outbox commit is all-or-none. Concurrent projector fixtures
  prove one linear chain. Verification detects interior edits, tail truncation, and missing files
  against `ledger_heads`.
- **Idempotency key hygiene** — a grep/AST guard flags an `idempotency.key` body referencing
  `attempt`, `index`, `runId`, or array position (the doc1/doc2 ban); keys must read input fields.
- **Transaction pairing** — every prepare and commit contract is paired in a transaction node;
  neither is legal standalone, the lease scope is transaction-wide, and a dry-run executable plan
  contains the prepare arm but zero commit arms or mutation capabilities (doc 10).

---

## 9. Composition with the existing docs (no redefinition)

- **Charter §1a (fill/submit split).** Fill is `effect:"prepare"`, submit/save/upload is
  `effect:"commit"`, and one transaction node retains the page lease across both. A dry-run plan
  includes prepare and excludes commit, so no fence/probe/ledger work begins.
- **Doc 01 §6.2 (mutation primitive).** `stores/common/mutation.ts` accepts only the commit ctx's
  capability bound to the open intent generation; no boolean dry-run branch exists.
- **Doc 02 §5.6/§5.7 (checkpoints/resume).** Transaction nodes checkpoint their full typed
  `TransactionOutcome`
  and retain the validated proof on the permanent intent; a transaction
  whose committed/satisfied key exists reuses its validated proof+output. Beat ⑥'s transaction-output checkpoint and
  the `write_intents` row share the `(workflow,item_id,step_id,attempt)` key. §5.6 #2 is upgraded per
  §4. The freshness walk (D8) is orthogonal and upstream: it keeps *stale read data* out of the fill;
  write-safety keeps duplicate writes out of commit — two different holes, two different guards.
- **Doc 02 gates (D5).** `PARKED(needs-operator)` is doc 02's park state; write-safety is one of the
  producers of it. Parking closes browser contexts before releasing exclusive leases; resume reacquires and
  re-enters at the recovery probe.
- **Doc 03 (spans/storage/ledger dir).** `write.attempting` and `write.committed` are two new span
  events (the fence + the commit); the proof rides a `span.patched` detail on the run. Per **D21**,
  doc 03 OWNS and adds the `ledger/` dir (never-pruned retention floor) and the `write_intents`
  SQLite **system-of-record** table (added to the D14 set) in its storage layout — this doc
  references them, it does not place them in the `.tracker/` tree.
- **Clock/instance (doc 11).** Every timestamp (`fenced_at`, `committed_at`, ledger `fencedAt` /
  `confirmedAt` / optional `externalOccurredAt`) comes from the
  injectable Clock; `operator` and `instance` (prod/test) come from the config/secrets domain and
  RunEnvelope — all owned by **doc 11** — so the ledger never fabricates a time or lets a test read
  look like a prod filing.

---

## 10. Port inventory (verbatim-wrapped vs newly built)

**Ports verbatim, wrapped in the contract:**
- UCPath `waitForTransactionOutcome` (polls, RETURNS `"timeout"` on neither-signal) + its caller
  `clickSaveAndSubmit`'s "outcome unknown, refusing to report success" throw (`transaction.ts:855-859`)
  + `readLatestTransactionNumber` (`transaction.ts:919-985`) → UCPath submit tasks' `receipt`
  capture (beat ⑤) and the `""`-means-unknown rule (fail-closed #4). The by-EID (not name) row
  re-find ports as-is.
- ServiceNow `submitAndCaptureTicketNumber` + `parseTicketNumberFromUrl` (`fill-form.ts:140-173`) →
  ServiceNow `receipt` capture.
- oath-upload `submitAttempted` + `hasUnverifiedPriorSubmit` + `findPriorTicketForSession` +
  SQLite-fast-path recovery (`handler.ts:249,273,309,388-454`) → the generalized `write_intents`
  fence + the recovery-probe replay (§4).
- Separations `findExistingTerminationTransaction` (`steps/ucpath-transaction.ts:83-104`) → the
  `ucpath/find-existing-termination` probe; `deletePendingTransaction` (`transaction.ts:1167`) → the
  `ucpath/clear-pending-terminations` cleanup transaction (§5).
- Onboarding `findExistingHireTransaction` + `decideHireDuplicateSkip` (`workflow.ts:488-521`) → the
  hire probe — its verdict widened from boolean fail-open to `ProbeVerdict` (its high-confidence skip
  becomes `present`; its low-confidence "fail open→submit" becomes `absent`; its genuinely-ambiguous
  case becomes `ambiguous`→park, which is the safety upgrade).

**Newly built (mostly the write-ahead layer — the gap audit's "mostly new"):**
- The permanent-key intent table, atomic outboxes, fixed sequencer, `ProbeVerdict`, serialized
  ledger projector + anchored hash-chain, and recovery reconciliation.
- **Kuali `kuali/read-saved-document`** — a positive `save-verify` read-back that does NOT exist today
  (Kuali removed its error detection as false-positive-prone). Must be built and live-verified before
  Kuali submit tasks can instantiate a passing `completion`.
- **OnBase `onbase/read-filed-document`** — a positive `upload-verify` read-back replacing today's
  negative "not an error page" (`handler.ts:208-217`). If a reliable positive read proves infeasible,
  the documented `unverifiableByPage` allowlist makes the OnBase submit **always** park for the
  operator's manual confirmation (which the operator already does — §13).

---

## 11. Adversarial self-review — how this could still fail, and residual risk

- **Same-key sequential/concurrent dedupe and recovery backfill are closed.** The permanent
  `(system,idempotency_key)` primary key covers attempting and committed states, so a later pristine
  run cannot fence again. Recovery no longer trusts a present proof blind: the completion arm's
  `proofSchema` parses it, parse-fail →
  park, so there is no unvalidated path to `done`. **Honest scope (D20):** this closes
  double-*file*, NOT duplicate-*person* — that racy-read class stays a disclosed residual (next
  bullet), not a structural guarantee.
- **The probe/verify read is itself a read that can lie.** A false `present` skips a needed write; a
  false `absent` double-submits. This re-introduces the exact fail-open hazard if sloppy. *Guards:*
  zero-age freshness (never a checkpoint); exact-match on the stable key; `ambiguous`/`unknown`
  park; a throwing probe is `unknown`, not `absent` (charter catch-swallow ban). **Residual:** a
  probe that reads too early (the duplicate-person root cause) could report `absent` on a
  still-rendering page — mitigated only by porting the race-based classifiers
  (`raceNewHireVsRehireSignal`) into the probe impls, a review+live-verify discipline, not a
  mechanical guard. **This is the deepest residual and must be live-verified per probe at migration.**
- **Kuali/OnBase have no machine receipt.** `save-verify`/`upload-verify` reads may themselves be
  weak (Kuali's deleted error-detection was false-positive-prone). **Residual, stated honestly:** if
  a reliable positive read-back can't be built, OnBase falls to `unverifiableByPage`→always-park and
  Kuali's `save-verify` may over-park on benign pages. Over-parking is fail-*closed* (safe but noisy);
  the real risk is a `save-verify` that returns a false `present` and reports a save that didn't land.
  This is the one place the fail-closed guarantee rests on read quality we cannot fully mechanize.
- **Wrong-DATA is not covered here.** Write-safety prevents *duplicate* filings, not *wrong* ones
  (`T002173685`). That axis is doc 02 freshness (D8) + the identity-approval gate. Write-safety's only
  contribution is making the wrong filing *auditable* in the ledger. Stated so no one mistakes
  exactly-once for correctness-of-content.
- **Fence bypass.** A future submit task could fire a raw click outside the mutation primitive.
  *Guard:* inline-`page.` bans (doc 01/02) keep clicks inside `stores/*`; the primitive is the only
  sanctioned submit path and it requires a fence; and per **D22** doc 10's
  `commit-routes-through-mutation` ratchet is an import/capability check that every `effect:"commit"`
  impl routes its submit click through `stores/common/mutation.ts` — so "fence-before-click is
  unbypassable" is now structural, not grep-hopeful. **Residual:** a leaf that reaches a submit via a
  novel un-wrapped helper the import walk doesn't recognize as a click — narrowed to review, not
  wide open.
- **Probe-policy misconfig.** `"retries-and-recovery-only"` can miss a transaction created outside
  this ledger on a pristine key; it cannot bypass durable committed history. The choice remains a
  required migration decision and should default by review preference to `always`.
- **Ledger tamper / loss.** The SQLite tail anchor detects file truncation/loss but remains local; an
  attacker rewriting both DB and file is out of scope. External signing remains an escalation path.

---

## 12. Worked example — a separations termination, with a crash

Input `{ emplId:"10694136", action:"termination", effectiveDate:"08/01/2026" }`, dry-run **off**,
`instance:"prod"`. Composed nodes: cleanup transaction → termination transaction whose prepare arm
is `ucpath/fill-termination`, commit arm is `ucpath/submit-termination`, and probe policy is always.

**Happy path (six beats):**
```
bind stable commit input + key="10694136|termination|08/01/2026"
① durable lookup → unseen; separate read lease runs find-existing-termination → { state:"absent" }
   release read lease; record monotonic probe completion
② acquire exclusive transaction lease; fill-termination stages the form
③ probe age < probeToFenceMaxMs; fence write_intents{key,status:"attempting"} COMMITTED (SQLite)
   → span write.attempting
④ commit mutation primitive: Save+Submit click (matching fence capability → fires)
⑤ capture readLatestTransactionNumber (re-nav on retained transaction page) → "T002173999"
         pick(o)=o.receipt; schema z.object({transactionNumber:/^T\d{6,}$/}).parse → ok
⑥ atomic DB commit: typed TransactionOutcome{disposition:"committed",proofSource:"normal-output"}
                        checkpoint + write_intents{status:"committed",
                           proof_json, output_json}
         + ledger/span outboxes { system:"ucpath", idempotencyKey:"10694136|termination|08/01/2026",
                           proof:{transactionNumber:"T002173999"}, operator, instance:"prod",
                           dryRun:false, proofSource:"normal-output",
                           fencedAt, confirmedAt:clock.now() }
           // ledger projector assigns seq/prevHash only after claiming this outbox
         + span write.committed + span.ended(done)
```

**Crash AFTER the click (④) but BEFORE capture (⑤).** The daemon dies; the Save landed in PeopleSoft
but no receipt was recorded. Lease expiry re-enqueues the run; recovery (§4) runs FIRST:
```
scan write_intents (separations, 10694136-item, ucpath-submit) → status:"attempting", no committed
re-run ucpath/find-existing-termination key="10694136|termination|08/01/2026"
  → { state:"present", proof:{transactionNumber:"T002173999"} }   // the row PeopleSoft now shows
⇒ BACKFILL in one DB transaction: committed proof + ledger/span outboxes + done
⇒ NO second Save. Exactly-once holds.
```
Had the probe returned `absent` → mark the same intent retryable, then CAS a new generation and run
safely. Had it returned `ambiguous` (two "Terminatn" rows for that EID+date) or
`unknown` (grid didn't render) → `PARKED(needs-operator)`: *"termination for EID 10694136 effdt
08/01/2026: probe found 2 matches / probe indeterminate — verify in UCPath, then retry or mark
done."* Had the present proof failed `proofSchema` → `PARKED`, never `done`.
Never a guess, never a duplicate `T…`.

**Two runs, same key (D18).** Suppose a second run for the same
`{10694136, termination, 08/01/2026}` starts while the first is mid-submit. Its beat ① consults
`write_intents` FIRST, finds the first run's `attempting` row on
`idempotency_key="10694136|termination|08/01/2026"`, and **fails loud without fencing or clicking** —
*"another run is mid-submit for key 10694136|termination|08/01/2026 — refusing to double-fence."*
Even if two starters race, one permanent-key INSERT/CAS wins. After commit, any future run finds and
reuses the proof. Concurrent and sequential duplicates are both blocked.

**Honest scope (D20).** This is how the double-**FILE** class is closed: the fence + same-key mutex
(D18), plus the pre-Save `present` probe and the recovery probe, mean two runs — or one crashed run —
cannot both file the same transaction, and every uncertain state parks instead of fail-open→SUBMIT.
The duplicate-**PERSON** class (the too-early racy read that classified a rehire as a new hire — §0)
is **NOT** structurally closed by this layer: it is a **disclosed residual**, mitigated by porting
the race-classifiers into the probe impls + per-probe live verification + the conditional,
create-path pending-termination sweep (§11). Exactly-once here means *no double-file*, not
*no wrong-person*.

---

## 13. Open questions for the operator / orchestrator

1. **Kuali `save-verify` reliability.** Can a positive read-back prove a Kuali save landed (re-read
   the saved fields / a "saved" state), given error detection was removed as false-positive-prone —
   or is Kuali's completion inherently "networkidle + operator spot-check," i.e. an allowlisted
   over-park? (Deepest Kuali residual, §11.)
2. **OnBase positive read-back vs always-park.** Is a live-verifiable "document filed" read achievable
   in OnBase, or does it take the `unverifiableByPage` allowlist → always-park for manual confirm
   (aligned with "operator tracks completion manually")?
3. ~~Ledger tamper-evidence altitude~~ — **resolved 2026-07-21:** local hash chain + independent
   SQLite tail anchor is diagnostic tamper-evidence, not a security boundary. Coordinated local
   DB+file rewriting is out of scope. External signing/anchoring is added only if a later compliance
   requirement names it; Phase 1 does not wait for an unanswered preference.
4. **Probe policy + elapsed budget per workflow (§b).** For each migrating workflow: `"always"`
   (safe, +1 round-trip) or `"retries-and-recovery-only"` (cannot detect a prior external write on
   an unseen key), and what justified `probeToFenceMaxMs` bounds preparation after that probe?
   Asked per workflow at migration — this doc sets the mechanism, not the values.
5. **Pending-sweep as write-safety.** Should `ucpath/clear-pending-terminations` (the date-agnostic
   sweep — the real duplicate guard today) be a first-class write-safety pre-step on every UCPath
   create path, or only on separations? It mutates (deletes rows), so it needs its own fence/ledger
   treatment — confirm the modeling.
