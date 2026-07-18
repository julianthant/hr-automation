# 09 — Write-Safety: Exactly-Once for Real HR Mutations

Status: **Phase 0 design — for operator review.** Conforms to `00-charter.md` (§1a fill/submit
split, §13 write-safety + the binding operator answers of 2026-07-18, §b migration questionnaire),
the reconciliation memo `04-reconciliation.md` (D5/D7/D8/D14), and the top finding of the gap audit
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
| The **write-safety contract** — the `WriteSafety` field on a mutate task (receipt/verify + idempotency probe + key), the three completion-check kinds, the `ProbeVerdict` three-valued protocol |
| The **kernel write sequence** — probe → fence → submit → capture/verify → commit, and its ordering invariant |
| The **crash-window fence** (`write_intents` SQLite table) and the **crash-recovery replay** (recovery-probe branching) |
| **Double-submit prevention** — idempotency key derivation + the per-workflow probe-policy knob (§b) |
| The **immutable receipt/transaction ledger** — schema, location, never-pruned guarantee, hash-chain, what one entry records |

| This doc **references** (owner) |
|---|
| `MutateTaskContract`, `effect:"mutate"`, dry-run mechanics (`ctx.dryRun`, simulate/unsupported), the mutation-primitive choke `stores/common/mutation.ts`, error taxonomy, `freshness`, contract/impl split, service vs browser stores → **doc 01** |
| Run-state machine incl. gates + `PARKED(needs-operator)`, checkpoint store + `captured_at`, resume/`startAt`, the freshness bind-graph walk, `RunEnvelope` (`dryRun`, `instance`) → **doc 02** |
| Span/note wire schema, `.tracker/` storage layout, SQLite system-of-record vs projection split (D14), completion fan-out union → **doc 03** |
| The injectable Clock (all timestamps), per-run test/prod instance selection, the config/secrets domain → **doc 11 (clock/config/secrets)** |
| The fill↔submit pairing guard + dry-run composition guard → **doc 10 (guard-architecture)** |

Amendments at sibling seams (each is a one-owner-per-concept addition, not a redefinition):
- **Doc 01 §2.2** — `MutateTaskContract` gains a `writeSafety` field; its *shape* is owned here.
- **Doc 01 §6.2** — the mutation primitive gains a second precondition (an open fence), beside the
  existing dry-run throw. One choke point, two guards.
- **Doc 02 §5.6 #2 / §OQ2 (per D17 — doc 02 OWNS and adds these).** "Crash-mid-write always parks"
  becomes **probe-then-park**, and the mutate step node gains the **required `probePolicy`** field.
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

> **Every `effect:"mutate"` submit task declares proof-of-landing (a receipt or a verify read-back)
> and an idempotency probe; the kernel drives a fixed probe → fence → submit → capture → commit
> sequence around it; and every "is it done / is it already there?" question is answered by a
> THREE-valued verdict where `unknown` blocks — never a boolean that lets uncertainty read as
> success.**

The single mechanism that makes fail-closed structural is the **`ProbeVerdict`**: a probe or verify
read cannot return `true/false`. It returns `present | absent | ambiguous | unknown`. `unknown` and
`ambiguous` route to `PARKED(needs-operator)` — never to a submit and never to a "done." This
directly dissolves today's fail-open dichotomy (onboarding: *"skip and never hire" vs "blind
double-submit"*): the third answer is **park and let the operator decide**, which is strictly safer
than both.

---

## 2. The write-safety contract

### 2.1 The `WriteSafety` field (owned here; attached to doc 01's `MutateTaskContract`)

```ts
// temp_src/domain/contracts/write-safety.ts — bundle-safe: imports zod + TaskId ONLY (D3 guard)
import { z } from "zod";
import type { TaskId } from "./base.js";

/** THREE-valued — the fail-closed heart. A probe/verify read task's OUTPUT schema MUST be (or
 *  extend) this. There is deliberately NO boolean form: "couldn't tell" can never look like "no". */
export const ProbeVerdict = z.discriminatedUnion("state", [
  z.object({ state: z.literal("present"),  receipt: z.unknown() }), // found — carries proof for backfill
  z.object({ state: z.literal("absent") }),                         // provably NOT present
  z.object({ state: z.literal("ambiguous"), matches: z.number().int().min(2) }), // >1 match — never guess
  z.object({ state: z.literal("unknown"),   reason: z.string() }),  // indeterminate — FAIL-CLOSED, parks
]);
export type ProbeVerdict = z.infer<typeof ProbeVerdict>;

/** UCPath / CRM / ServiceNow — the irreversible submits capture a verifiable receipt (operator §13). */
export interface ReceiptCheck<Out extends z.ZodType> {
  kind: "receipt";
  /** Extract the receipt slice from the submit task's typed output (the confirmation/ticket number). */
  pick: (output: z.output<Out>) => unknown;
  /** NON-EMPTY schema the slice MUST satisfy. `submitted:true` whose picked receipt is null/empty or
   *  fails this schema is a FAIL-LOUD park, never "done" (a guard rejects trivially-empty schemas). */
  schema: z.ZodType;
}
/** Kuali — SAVE-only, NOT a receipt-bearing submit (operator §13). No confirmation number exists;
 *  a read task re-reads the just-saved record and returns a ProbeVerdict of whether the save landed. */
export interface SaveVerifyCheck { kind: "save-verify"; verify: TaskId; }
/** OnBase — operator tracks completion manually (operator §13); automation must be VERY sure the
 *  upload landed. A POSITIVE read-back (not merely "not an error page") returning a ProbeVerdict. */
export interface UploadVerifyCheck {
  kind: "upload-verify"; verify: TaskId;
  /** Escape hatch (allowlisted + argued in doc 10): the page genuinely cannot prove landing. Then the
   *  submit ALWAYS parks needs-operator for manual confirmation — it never auto-reports done. */
  unverifiableByPage?: { reason: string };
}
export type CompletionCheck<Out extends z.ZodType> =
  ReceiptCheck<Out> | SaveVerifyCheck | UploadVerifyCheck;

export interface Idempotency<In extends z.ZodType> {
  /** A read task answering "is THIS exact transaction already present?" → ProbeVerdict. Runs
   *  pre-write AND on crash recovery. Declared with freshness.maxAgeMs:0 (always live, never a stale
   *  checkpoint). Must resolve to a real effect:"read" task in the SAME store (guard §8). */
  probe: TaskId;
  /** The natural idempotency KEY — derived from STABLE business identity, NEVER row/position/index
   *  (the doc1/doc2 fix, §5). e.g. `${eid}|termination|${effectiveDate}`. Pure. */
  key: (input: z.output<In>) => string;
}

export interface WriteSafety<In extends z.ZodType, Out extends z.ZodType> {
  completion: CompletionCheck<Out>;
  idempotency: Idempotency<In>;
}
```

`MutateTaskContract<Id, In, Out, Codes>` (doc 01 §2.2) gains **`writeSafety: WriteSafety<In, Out>`**
(or, rarely, an allowlisted `writeSafety: { genuinelyIdempotent: { reason } }` — §8). The receipt is
part of the submit task's typed **output** (operator §13: "…as its typed output"), so `pick` slices
it; the probe/verify are separate `read` tasks in the same store.

### 2.2 Per-system instantiation (three shapes, one mechanism)

```ts
// UCPath termination — receipt-bearing (ports transaction.ts:919-985 into ucpath/read-transaction-number)
writeSafety: {
  completion: { kind: "receipt",
    pick: (o) => o.receipt,
    schema: z.object({ transactionNumber: z.string().regex(/^T\d{6,}$/) }) },
  idempotency: {
    probe: "ucpath/find-existing-termination",                 // by EID + effdt + "Terminatn"
    key:   (i) => `${i.emplId}|termination|${i.effectiveDate}` },
}
// ServiceNow ticket — receipt-bearing (ports fill-form.ts:140-173)
completion: { kind: "receipt", pick: (o) => o.ticketNumber, schema: z.string().regex(/^HRC\d{6,}$/) }
// Kuali save — save-verify, NO receipt (operator §13)
completion: { kind: "save-verify", verify: "kuali/read-saved-document" }
// OnBase upload — upload-verify, positive read-back OR allowlisted unverifiable→always-park
completion: { kind: "upload-verify", verify: "onbase/read-filed-document" }
```

Kuali and OnBase are the one place the port is a **genuine addition** (§10): their submit tasks
cannot instantiate a passing `completion` without a new post-write read-back, because today they have
none. That is by design — the contract *forces* proof to exist.

---

## 3. The kernel write sequence

The kernel drives a **fixed five-beat sequence** around every real (non-dry-run) mutate submit. The
impl author cannot reorder it; the fill is a separate `read`-safe task (charter §1a) and is not part
of this sequence.

```
① PROBE   → ② FENCE → ③ SUBMIT → ④ CAPTURE/VERIFY → ⑤ COMMIT
   read       durable    click        read-back           durable + ledger + span
```

| Beat | What runs | What is DURABLE at end of beat | Fail-closed exit |
|---|---|---|---|
| **① Probe** (pre-write) | **FIRST consult `write_intents` (D18)** for an un-committed `attempting` row on the SAME `idempotency_key` — this happens **before** the live-page read. If one exists, another run holds the fence for this exact transaction: this run does **not** fence or submit — it **fails loud** *"another run is mid-submit for key <k> — refusing to double-fence"* (a retry/operator resolves once the holder commits or clears). Only if no in-flight intent exists does the beat run `idempotency.probe(key)` — a live read, `freshness.maxAgeMs:0`. Per the probe-policy knob (§5) the *live-page* read may be **skipped on a pristine first attempt**; the `write_intents` consult is **never** skipped, and neither is skipped on a retry/resume. | nothing (a read) | in-flight same-key intent ⇒ **fail loud, no fence** (D18). `present` ⇒ complete `done { submitted:false, reason:"already-present", receipt }` (doc 01 §6.2 honest no-op) + ledger note, **no submit**. `ambiguous`/`unknown` ⇒ `PARKED(needs-operator)`. `absent` ⇒ proceed. A probe that **throws** = `unknown` (never "absent"). |
| **② Fence** | Commit a `write_intents` row (SQLite, system-of-record) `{key, status:"attempting"}` **before the click** — the partial-unique in-flight index (D18) makes this INSERT the same-key **mutex**: it FAILS if another run already holds an un-committed intent for this `idempotency_key`, failing the run loud rather than double-fencing (the backstop to beat ①'s consult under a race); then emit `write.attempting` span. | `write_intents` row (D14 system-of-record) | INSERT conflict on the in-flight-key index ⇒ fail loud (D18), no click |
| **③ Submit** | `stores/common/mutation.ts` primitive fires the single irreversible click. It throws if `ctx.dryRun` (doc 01 §6.2) AND if no open fence exists for `(runId, step, attempt)` — fence-before-click is unbypassable. | the live HR side effect | primitive-not-fenced ⇒ throw (corruption, loud) |
| **④ Capture / Verify** | `receipt`: read back the confirmation/ticket number, `pick` + `schema.parse`. `save-verify`/`upload-verify`: run the `verify` read → `ProbeVerdict`. | nothing yet (still in memory) | receipt missing/empty/`""`/schema-fail ⇒ `PARKED` ("clicked, cannot prove it landed — verify in <system>"). verify `present` ⇒ ok; anything else (`absent`/`ambiguous`/`unknown`/throw) ⇒ `PARKED`. |
| **⑤ Commit** | ONE ordered commit: (a) receipt checkpoint + `write_intents.status:"committed", receipt_json` (SQLite); (b) **append the immutable ledger entry** (idempotent by `(runId,step,attempt)`); (c) emit `write.committed` span + `span.ended(done)`. | receipt checkpoint + committed intent + **ledger entry** | a `write.committed` span with no ledger entry ⇒ backfilled on next read + flagged (§6) |

**Ordering invariant (extends doc 02 §5.6 + doc 03 §2.3):** the `write_intents` SQLite commit in ②
**happens-before** the click in ③, which happens-before the receipt/verify read in ④, which
happens-before the SQLite committed-write in ⑤(a), which happens-before the ledger append ⑤(b), which
happens-before the spans ⑤(c). "Span says committed, no durable intent" is impossible by
construction and treated as corruption (loud) if ever observed. This generalizes oath-upload's
"marker durable before the POST" (`handler.ts:306-309`) into the kernel.

```sql
-- temp_src state.db — SYSTEM-OF-RECORD (D14: not rebuildable, not deletable). The crash-window fence.
CREATE TABLE write_intents (
  workflow        TEXT NOT NULL,
  item_id         TEXT NOT NULL,   -- (workflow,item_id) logical key, mirrors run_checkpoints (doc 02 §5.7)
  step_id         TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  system          TEXT NOT NULL,   -- SystemId
  idempotency_key TEXT NOT NULL,   -- idempotency.key(input) — the natural key + the D18 mutex column
  status          TEXT NOT NULL,   -- 'attempting' | 'committed'
  fenced_at       TEXT NOT NULL,   -- clock.now() (doc 11) — before the click
  committed_at    TEXT,            -- null until ⑤
  receipt_json    TEXT,            -- captured receipt/verify proof (null until ⑤)
  PRIMARY KEY (workflow, item_id, step_id, attempt)
);
-- D18 — same-key concurrency mutex: AT MOST ONE un-committed intent per idempotency_key.
-- The fence INSERT (beat ②) fails if another run already holds an 'attempting' row for this key,
-- so two runs deriving the same key can never both fence-and-click. Partial index: 'committed'
-- history is exempt and accretes freely; only the in-flight set is mutually exclusive.
CREATE UNIQUE INDEX write_intents_inflight_key
  ON write_intents (idempotency_key) WHERE status = 'attempting';
```

---

## 4. Crash-window recovery (the exactly-once guarantee)

**The guarantee, stated precisely:** for any real mutate submit, after a crash at *any* point the
run reaches exactly one of three terminal states, and **never double-files**:

1. **The write landed** (crash anywhere after ③) → recovery's probe returns `present` → the kernel
   runs **`completion.schema.parse` on the probe verdict's receipt (D19)** — the SAME validation
   beat ④ runs; a `present` receipt is never trusted blind. On parse **success** it **backfills** the
   receipt, marks the intent `committed`, appends the ledger entry, and completes `done` (no second
   submit). On parse **failure** it **parks `needs-operator`** (a `present` we cannot validate is
   indeterminate, not done). There is **NO path to `done` with an unvalidated receipt — recovery
   included.**
2. **The write never landed** (crash between ② and ③, or a genuinely-not-sent click) → recovery's
   probe returns `absent` → the intent is cleared and the five-beat is safe to re-run from ①.
3. **Indeterminate** (probe returns `ambiguous`/`unknown`, or throws) → `PARKED(needs-operator)` with
   a legible message naming the key, the system, and the match count — the operator verifies in the
   target system and marks done or retries. Never a guess.

**Recovery replay (resolves doc 02 §OQ2 — replaces "always park"):** on resume, the kernel first
scans `write_intents` for the resuming `(workflow,item_id,step_id)`. If it finds a row with
`status:"attempting"` and no `committed`, it **re-runs `idempotency.probe(key)` FIRST** (before any
`startAt` step logic) and routes on the verdict per 1/2/3 above. Only after the probe resolves does
normal resume proceed. A non-mutate step with no fence auto-resumes as today (worst case: a repeated
read). This reads durable state from SQLite (system-of-record), never post-crash JSONL, mirroring
oath-upload's SQLite-fast-path recovery (`handler.ts:427-429`).

---

## 5. Double-submit prevention

**Idempotency key from stable identity, never position.** The `key` function takes the parsed
workflow-derived input and returns a natural business key: `${eid}|termination|${effectiveDate}`,
`${sessionId}|${pdfHash}` (oath-upload today), `${eid}|hire|${jobCode}|${effdt}` (onboarding — note
hires have no EID pre-hire, so the key uses name+effdt+jobCode, the same fields
`findExistingHireTransaction` matches on). It **never** incorporates run position, attempt number,
array index, or the OCR fan-out index — that is the doc1/doc2 (E2E-015) shared-id fallback, banned in
the fan-out (`buildFanOutItemIdResolver`) and banned here (§8). Two runs for the same
person+type+date derive the same key, so beat ① sees the first run's `present` and refuses to
double-file.

**Two probe kinds are distinct and both port** (separations taught us the difference):
- The **idempotency probe** reads *processed/filed* transactions (a committed `T…` exists) —
  `findExistingTerminationTransaction` keyed EID+effdt+"Terminatn".
- The **date-agnostic pending sweep** (`deletePendingTransaction`, `transaction.ts:1167`) is a
  *mutate cleanup* that deletes ALL in-progress unprocessed Terminat rows for the EID regardless of
  effdt — it catches a stale prior attempt carrying a *different* computed effdt that the date-keyed
  probe misses. It ports as its own `ucpath/clear-pending-terminations` mutate task composed BEFORE
  the submit (it has its own trivial write-safety: idempotent by construction — deleting nothing is
  `absent`, its "receipt" is the count of rows cleared).

**The per-workflow probe-policy knob (charter §b — decided at migration, NOT defaulted here).** Beat
① (the *pre-write* probe) is governed by a per-workflow knob; the *recovery* probe (§4) is always on
regardless.

```ts
// on the mutate step node of the descriptor (doc 02 OWNS/adds this field per D17; semantics owned here)
probePolicy: "always" | "retries-and-recovery-only";   // REQUIRED on a mutate step — no default
```

- `"always"` — probe before every submit (one extra live read per submit; safest; closes the crash
  window even on the first attempt).
- `"retries-and-recovery-only"` — skip beat ① on a pristine first attempt (attempt 1, no prior
  `write_intents` row), accepting a first-attempt crash-window that the recovery probe still closes
  on the *next* run; probe on every retry/resume. Trades one round-trip for a narrow first-attempt
  window (the doc 05 speed tension, gap-audit OQ2).

The field is **required** (compile error if omitted on a mutate step), which forces the §b migration
question to be answered per workflow. There is **no hardcoded default** — the operator deferred it.

---

## 6. The immutable receipt / transaction ledger

**Purpose (operator §13):** an immutable record of what real transactions were actually filed, **never
pruned** — it outlives doc 03's decided base retention (spans 30d / notes 7d, D21) and the
`clean-tracker` sweep.

```ts
// temp_src/domain/ledger.ts — the at-rest ledger entry (append-only). Written at beat ⑤(b).
export interface LedgerEntry {
  seq: number;                    // monotonic per file — truncation is detectable
  prevHash: string;               // sha256 of the previous entry's canonical JSON ("" for seq 0)
  workflow: string;
  itemId: string;
  system: string;                 // SystemId — ucpath | crm | servicenow | kuali | onbase
  idempotencyKey: string;         // the natural key (§5) — dedupe + audit join
  receipt: unknown;               // the confirmation/ticket number, or the verify proof (Kuali/OnBase)
  completionKind: "receipt" | "save-verify" | "upload-verify";
  runId: string; traceId: string; attempt: number;
  operator: string;               // from the config/secrets domain (doc 11), never fabricated
  instance: "prod" | "test";      // RunEnvelope.instance (doc 11) — a test read can never look like a prod file
  dryRun: false;                  // real writes only; a dry run composes no submit, so writes NO ledger entry
  filedAt: string;                // clock.now() (doc 11) — the single source of time
}
```

- **Location:** `.tracker/ledger/<system>-<YYYY-MM-DD>.jsonl` (doc 03 §2.1 adds the dir). JSONL so the
  operator greps it; per-system+day partition so `grep 10694136 .tracker/ledger/ucpath-*.jsonl`
  answers "what did we file for this person?" across time.
- **Never pruned (retention floor):** `clean-tracker` (which prunes `spans/` at 30d and `notes/` at
  7d — doc 03's decided base retention, D21) skips `ledger/` unconditionally — a ratchet guard fails
  if any prune path can reach `ledger/`. This is the "immutable transaction ledger, never pruned" of
  operator §13. The never-pruned floor sits above a *settled* number (D21), not a guessed one.
- **Hash-chain — decision: YES, lightweight.** Each entry carries `seq` + `prevHash` (sha256 of the
  prior entry's canonical JSON), forming a per-file chain. A `cli ledger verify` walks the chain and
  reports any break. This is cheap, local, and gives **tamper-evidence** (edits/truncation are
  detectable) — honestly **not** tamper-*proof* (no external signing/anchoring; a local attacker who
  rewrites the whole file undetected is out of scope for a single-operator tool). It is the right
  altitude: enough to trust the audit trail, no HSM ceremony. Escalation to signed/anchored is a
  documented future option (§13 Q3), not built now.
- **Append is idempotent** by `(runId, step, attempt)` — a crash-recovery backfill (§4 case 1)
  re-appending finds the entry present and no-ops; a `write.committed` span with *no* ledger entry is
  backfilled on the next read and flagged loud (the ledger, not the span, is the audit authority).
- **One entry = one filed transaction.** The ledger is the durable superset of the `write.committed`
  span events (gap-audit gap 5: "receipts ARE the ledger").

---

## 7. Fail-closed everywhere — every place `unknown` could leak into `done`, and its exit

The operator's core requirement. Exhaustive:

| # | Where "unknown" could become "done" | Fail-closed exit |
|---|---|---|
| 1 | Pre-write probe (①) can't determine presence | `unknown` verdict ⇒ `PARKED(needs-operator)` — never submit |
| 2 | Pre-write probe finds >1 match | `ambiguous` ⇒ `PARKED` — never guess which is "the" transaction |
| 3 | Probe read **throws** (page/net error) | wrapped as `unknown` (a failed check ≠ "found nothing" — the charter catch-swallow ban) ⇒ `PARKED` |
| 4 | Receipt read-back returns `""` (UCPath) / no `number=` (ServiceNow) | missing/empty receipt ⇒ `PARKED("clicked, cannot prove it landed")` — mirrors today's "refusing to report success" throw |
| 5 | Captured receipt fails its `schema` | schema-fail ⇒ `PARKED`, never `done{submitted:true}` |
| 6 | Kuali `save-verify` can't confirm the save | any verdict ≠ `present` ⇒ `PARKED` |
| 7 | OnBase `upload-verify` can't confirm the filing | any verdict ≠ `present` ⇒ `PARKED`; `unverifiableByPage` allowlist ⇒ **always** `PARKED` for manual confirm (never auto-done) |
| 8 | Crash mid-write, recovery probe indeterminate | `ambiguous`/`unknown`/throw ⇒ `PARKED`; `present` ⇒ backfill-done **only if its receipt passes `completion.schema.parse` (D19)**, else `PARKED`; `absent`→retry |
| 9 | A mutate `run` returns `{submitted:true}` with no receipt/verify evidence | kernel rejects at ④ (the contract owns the check, not the impl) ⇒ `PARKED` |
| 10 | The mutation primitive fired without a fence (a mis-authored submit) | primitive throws (③) — corruption, loud |
| 11 | dry-run: no submit composed at all (charter §1a) | write-safety never engages; nothing to make done — clean, no leak |

The unifying rule: **only `present` (or a schema-valid receipt) yields `done`. Every other outcome —
absent-after-click, ambiguous, unknown, throw, empty — parks or retries.** A boolean probe would
collapse #1/#3/#8 into "false ⇒ proceed"; the `ProbeVerdict` type makes that collapse
*unrepresentable*.

---

## 8. Mechanical guards (fail-loud ratchets, `npm run test:architecture`)

- **`write-safety-contract.test.ts`** — every `effect:"mutate"` contract MUST declare `writeSafety`
  with a `completion` and an `idempotency`, OR an allowlisted `{ genuinelyIdempotent:{reason} }`
  entry (rare, argued — same `Record<file,{reason}>` shape as the existing ratchets). Pins: a
  `receipt.schema` that parses `{}`/`undefined`/`null` fails (non-empty required); a mutate `run`
  returning `submitted:true` with a receipt failing its schema throws (unit fixture).
- **Probe/verify resolution** — `idempotency.probe` and any `save-verify`/`upload-verify` `verify`
  TaskId resolve to a real `effect:"read"` task in the **same store**, whose output is (or extends)
  `ProbeVerdict`, whose contract declares `freshness.maxAgeMs:0`. Table-driven over the store index.
- **Fence-before-click** — a unit fixture asserts the `write_intents` SQLite commit is observed
  before the mutation primitive is invoked; the primitive throws when invoked with no open fence.
- **Same-key concurrency (D18)** — a fixture opens two runs deriving the SAME `idempotency_key`: the
  first fences; the second's beat-① `write_intents` consult fails it loud, and (backstop under a
  race) the partial-unique in-flight index rejects its fence INSERT. Pins that two same-key runs can
  never both fence-and-click — exactly-once holds under concurrency, not only under crashes.
- **Crash-recovery** — a fixture injects a `write_intents{status:"attempting"}` with no `committed`
  and asserts the recovery probe runs FIRST and routes present→(schema-parse then)backfill /
  present-with-receipt-failing-schema→park (D19) / absent→retry / unknown→park (four cases pinned).
- **Ledger integrity** — a `write.committed` span with no matching ledger entry fails a parity
  fixture; a `clean-tracker` dry-run that would delete any `ledger/` path fails the retention-floor
  guard; `cli ledger verify` is exercised on a tampered fixture (chain break detected).
- **Idempotency key hygiene** — a grep/AST guard flags an `idempotency.key` body referencing
  `attempt`, `index`, `runId`, or array position (the doc1/doc2 ban); keys must read input fields.
- **Fill↔submit pairing** — every form-filing mutate submit has a preceding `read` fill task in the
  same workflow (owned by **doc 10**; cross-referenced here because the dry-run boundary is the
  submit and write-safety only engages there). The dry-run composition guard (doc 10) proves a
  dry-run composition reaches no mutation primitive.

---

## 9. Composition with the existing docs (no redefinition)

- **Charter §1a (fill/submit split).** The fill task is `effect:"read"`, carries no `writeSafety`;
  the submit task IS the transaction boundary and carries the whole triple. A **dry-run composition
  excludes the submit task entirely** — so there is nothing to fence, probe, verify, or ledger in a
  dry run. Write-safety only ever engages on a real submit. Clean by construction.
- **Doc 01 §6.2 (mutation primitive).** The single choke `stores/common/mutation.ts` is the one home
  for both the dry-run throw (existing) and the fence-precondition (new). Beats ② and ③ are folded
  into the primitive wrapper so a submit cannot fire un-fenced.
- **Doc 02 §5.6/§5.7 (checkpoints/resume).** Receipts are `replay:"checkpoint"` outputs; a mutate
  step whose receipt checkpoint exists already refuses re-execution. Beat ⑤'s receipt checkpoint and
  the `write_intents` row share the `(workflow,item_id,step_id,attempt)` key. §5.6 #2 is upgraded per
  §4. The freshness walk (D8) is orthogonal and upstream: it keeps *stale read data* out of the fill;
  write-safety keeps *duplicate writes* out of the submit — two different holes, two different guards.
- **Doc 02 gates (D5).** `PARKED(needs-operator)` is doc 02's park state; write-safety is one of the
  producers of it. Parking releases browser sessions; resume reacquires (login idempotent) and
  re-enters at the recovery probe.
- **Doc 03 (spans/storage/ledger dir).** `write.attempting` and `write.committed` are two new span
  events (the fence + the commit); the receipt rides a `span.patched` detail on the run. Per **D21**,
  doc 03 OWNS and adds the `ledger/` dir (never-pruned retention floor) and the `write_intents`
  SQLite **system-of-record** table (added to the D14 set) in its storage layout — this doc
  references them, it does not place them in the `.tracker/` tree.
- **Clock/instance (doc 11).** Every timestamp (`fenced_at`, `committed_at`, `filedAt`) comes from the
  injectable Clock; `operator` and `instance` (prod/test) come from the config/secrets domain and
  RunEnvelope — all owned by **doc 11** — so the ledger never fabricates a time or lets a test read
  look like a prod filing.

---

## 10. Port inventory (verbatim-wrapped vs newly built)

**Ports verbatim, wrapped in the contract:**
- UCPath `waitForTransactionOutcome` (polls, RETURNS `"timeout"` on neither-signal) + its caller
  `clickSaveAndSubmit`'s "outcome unknown, refusing to report success" throw (`transaction.ts:855-859`)
  + `readLatestTransactionNumber` (`transaction.ts:919-985`) → UCPath submit tasks' `receipt`
  capture (beat ④) and the `""`-means-unknown rule (fail-closed #4). The by-EID (not name) row
  re-find ports as-is.
- ServiceNow `submitAndCaptureTicketNumber` + `parseTicketNumberFromUrl` (`fill-form.ts:140-173`) →
  ServiceNow `receipt` capture.
- oath-upload `submitAttempted` + `hasUnverifiedPriorSubmit` + `findPriorTicketForSession` +
  SQLite-fast-path recovery (`handler.ts:249,273,309,388-454`) → the generalized `write_intents`
  fence + the recovery-probe replay (§4).
- Separations `findExistingTerminationTransaction` (`steps/ucpath-transaction.ts:83-104`) → the
  `ucpath/find-existing-termination` probe; `deletePendingTransaction` (`transaction.ts:1167`) → the
  `ucpath/clear-pending-terminations` pre-submit mutate cleanup (§5).
- Onboarding `findExistingHireTransaction` + `decideHireDuplicateSkip` (`workflow.ts:488-521`) → the
  hire probe — its verdict widened from boolean fail-open to `ProbeVerdict` (its high-confidence skip
  becomes `present`; its low-confidence "fail open→submit" becomes `absent`; its genuinely-ambiguous
  case becomes `ambiguous`→park, which is the safety upgrade).

**Newly built (mostly the write-ahead layer — the gap audit's "mostly new"):**
- The `write_intents` fence table, the kernel five-beat sequencer, the `ProbeVerdict` protocol, the
  ledger + hash-chain + `cli ledger verify`, and the recovery-probe replay.
- **Kuali `kuali/read-saved-document`** — a positive `save-verify` read-back that does NOT exist today
  (Kuali removed its error detection as false-positive-prone). Must be built and live-verified before
  Kuali submit tasks can instantiate a passing `completion`.
- **OnBase `onbase/read-filed-document`** — a positive `upload-verify` read-back replacing today's
  negative "not an error page" (`handler.ts:208-217`). If a reliable positive read proves infeasible,
  the documented `unverifiableByPage` allowlist makes the OnBase submit **always** park for the
  operator's manual confirmation (which the operator already does — §13).

---

## 11. Adversarial self-review — how this could still fail, and residual risk

- **Same-key concurrency and recovery backfill are now closed (D18/D19).** Two runs deriving the same
  `idempotency_key` cannot both fence — beat ① consults `write_intents` before the live read, and the
  partial-unique in-flight index is the mutex backstop — so the double-**file** class is structurally
  shut (pinned by the concurrency + crash-recovery fixtures, §8). Recovery no longer trusts a
  `present` receipt blind: `completion.schema.parse` runs on the backfilled receipt, parse-fail →
  park, so there is no unvalidated path to `done`. **Honest scope (D20):** this closes
  double-*file*, NOT duplicate-*person* — that racy-read class stays a disclosed residual (next
  bullet), not a structural guarantee.
- **The probe/verify read is itself a read that can lie.** A false `present` skips a needed write; a
  false `absent` double-submits. This re-introduces the exact fail-open hazard if sloppy. *Guards:*
  `maxAgeMs:0` always-live (never a checkpoint); exact-match on the stable key; `ambiguous`/`unknown`
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
  `mutate-routes-through-mutation` ratchet is an **import-graph** check that every `effect:"mutate"`
  impl routes its submit click through `stores/common/mutation.ts` — so "fence-before-click is
  unbypassable" is now structural, not grep-hopeful. **Residual:** a leaf that reaches a submit via a
  novel un-wrapped helper the import walk doesn't recognize as a click — narrowed to review, not
  wide open.
- **Probe-policy misconfig.** `"retries-and-recovery-only"` re-opens the crash window on attempt 1;
  a wrong per-workflow choice is a real hazard. *Mitigation:* it's a required, reviewed §b decision
  recorded in the descriptor diff, and the recovery probe still closes it on the following run.
- **Ledger tamper / loss.** Local unsigned JSONL: the hash-chain detects edits/truncation but a full
  local rewrite is undetectable. **Residual:** acceptable for a single-operator tool; escalation path
  documented (§13 Q3).

---

## 12. Worked example — a separations termination, with a crash

Input `{ emplId:"10694136", action:"termination", effectiveDate:"08/01/2026" }`, dry-run **off**,
`instance:"prod"`. Composed nodes (charter §1a): `ucpath/clear-pending-terminations` (mutate cleanup)
→ `ucpath/fill-termination` (read-safe fill) → **`ucpath/submit-termination`** (the mutate submit,
`probePolicy:"always"`).

**Happy path (five beats):**
```
① probe  ucpath/find-existing-termination key="10694136|termination|08/01/2026" → { state:"absent" }
② fence  write_intents{key, status:"attempting", fenced_at:clock.now()} COMMITTED (SQLite)
         → span write.attempting
③ submit mutation primitive: Save+Submit click (fence present, dryRun false → fires)
④ capture readLatestTransactionNumber (re-nav, row by EID) → "T002173999"
         pick(o)=o.receipt; schema z.object({transactionNumber:/^T\d{6,}$/}).parse → ok
⑤ commit receipt checkpoint + write_intents{status:"committed", receipt_json}
         + ledger append { system:"ucpath", idempotencyKey:"10694136|termination|08/01/2026",
                           receipt:{transactionNumber:"T002173999"}, operator, instance:"prod",
                           dryRun:false, filedAt:clock.now(), seq:N, prevHash:… }
         + span write.committed + span.ended(done)
```

**Crash AFTER the click (③) but BEFORE capture (④).** The daemon dies; the Save landed in PeopleSoft
but no receipt was recorded. Lease expiry re-enqueues the run; recovery (§4) runs FIRST:
```
scan write_intents (separations, 10694136-item, ucpath-submit) → status:"attempting", no committed
re-run ucpath/find-existing-termination key="10694136|termination|08/01/2026"
  → { state:"present", receipt:{transactionNumber:"T002173999"} }   // the row PeopleSoft now shows
⇒ BACKFILL: write_intents{status:"committed", receipt_json} + ledger append (idempotent) + span.ended(done)
⇒ NO second Save. Exactly-once holds.
```
Had the probe returned `absent` (crash between ② and ③, click never fired) → clear the intent, re-run
the five-beat safely. Had it returned `ambiguous` (two "Terminatn" rows for that EID+date) or
`unknown` (grid didn't render) → `PARKED(needs-operator)`: *"termination for EID 10694136 effdt
08/01/2026: probe found 2 matches / probe indeterminate — verify in UCPath, then retry or mark
done."* Had `present`'s receipt failed `completion.schema.parse` (D19) → `PARKED`, never `done`.
Never a guess, never a duplicate `T…`.

**Two runs, same key (D18).** Suppose a second run for the same
`{10694136, termination, 08/01/2026}` starts while the first is mid-submit. Its beat ① consults
`write_intents` FIRST, finds the first run's `attempting` row on
`idempotency_key="10694136|termination|08/01/2026"`, and **fails loud without fencing or clicking** —
*"another run is mid-submit for key 10694136|termination|08/01/2026 — refusing to double-fence."*
Even if the consult raced two simultaneous starters, the second's beat-② fence INSERT hits the
partial-unique in-flight index and fails. Two same-key runs can never both fence.

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
3. **Ledger tamper-evidence altitude.** Is local unsigned hash-chained JSONL sufficient, or does
   compliance want external anchoring/signing (out of scope now, easy to add later)?
4. **Probe-policy default per workflow (§b).** For each migrating workflow: `"always"` (safe, +1
   round-trip) or `"retries-and-recovery-only"` (faster, narrow first-attempt window)? Asked per
   workflow at migration — this doc sets the mechanism, not the default.
5. **Pending-sweep as write-safety.** Should `ucpath/clear-pending-terminations` (the date-agnostic
   sweep — the real duplicate guard today) be a first-class write-safety pre-step on every UCPath
   create path, or only on separations? It mutates (deletes rows), so it needs its own fence/ledger
   treatment — confirm the modeling.
