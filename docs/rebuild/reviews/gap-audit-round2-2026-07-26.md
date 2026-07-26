# Gap audit, round 2 — the full 12-doc corpus (2026-07-26)

**Why this exists.** Doc `08` was a principal-architect pass over **four** docs (01, 02, 03, 05) plus
the charter and reconciliation. It found three BLOCKERs — write-safety, guard architecture, the
clock — and all three became owned docs (09, 10, 11). But docs **06 and 09–12 were written after
that audit** and have never received the same outside-in question: *what does a production,
single-operator, real-HR-transaction system need that **no doc owns**?* The closure matrices at the
top of doc 08 are review findings folded back; they are not a re-run of the method.

This is the re-run, against all twelve docs plus Round 8 (D73–D86).

**Method (same as doc 08).** Read for *seams*, not contents: a concern is a gap when every doc
touches it and none owns it, or when the D1 matrix has no row that would force someone to design
it. Findings are grounded in the doc text and in the as-built system, not imagined. Each names a
recommended owner.

**Headline.** The corpus is in much better shape than at round 1 — there is no BLOCKER of the
write-safety kind left. But Round 8 shifted the system's centre of gravity in a way the docs have
not caught up with: **pause-until-done (D73) plus always-gate (D77) make the operator's own
attention the scarcest resource in the program, and nothing owns it.** That is this round's top
finding, and it did not exist before 2026-07-24 — the decisions that created it are four days old.

---

## Ranked gap table

Risk key as doc 08: **BLOCKER** = unsafe/dishonest without it; **MAJOR** = a real hazard that bites
within the first migrations; **MINOR** = should be owned, bounded or partly covered.

| # | Concern | Owned today by | Risk | Recommended owner |
|---|---|---|---|---|
| 1 | **The operator's cross-run work queue** — everything waiting on a human, in one place, ordered | UNOWNED. Doc 12 owns per-run evidence "obligations"; doc 03 owns notification routing; nobody owns the *queue of human obligations across runs* | **MAJOR** (new, created by D77+D73) | **doc 12** (§ new) |
| 2 | **Kernel self-health** — is the executor itself OK? | Near-unowned. Two incidental mentions (doc 12 lists storage failures as a diagnostic category; doc 09 notes projector lag is repairable). Doc 05 owns backpressure *mechanism*, not its observability | **MAJOR** | **doc 05** (§ new) + a surface in doc 12 |
| 3 | **Retention/growth budget as a system** — ledger forever + archive forever + artifacts-until-purge + 30d spans/notes | PARTIAL. Retention *values* are settled (D86); doc 11 preflights disk space; master-plan risk #8 names the hazard with **no owner** | **MAJOR** | **doc 03** (storage owner) |
| 4 | **Archive as a subsystem** (D80) — sizing, browse performance, what "self-contained" costs on disk | PARTIAL — created 2026-07-24, specified as semantics in doc 03 §10.2, but its physical characteristics are undesigned | **MINOR** | **doc 03** (fold into #3) |
| 5 | **Single-instance safety** — two dashboards/executors against one authority DB | UNOWNED — zero hits corpus-wide | **MINOR** | **doc 03** (authority owner) or doc 05 |
| 6 | **Operator ordering/urgency** — which of 12 waiting items to do first | UNOWNED for humans. Doc 05 owns an `interactive` **lane** for machine scheduling; the human side has no analogue | **MINOR** (folds into #1) | **doc 12** |

Nothing here rises to BLOCKER. #1 is the one that would visibly hurt within the first migrated
workflows.

---

## GAP 1 — The operator's cross-run work queue (MAJOR, new)

### Why this is new, and why it is now the biggest one

Two decisions four days apart changed the operator's role:

- **D77 ALWAYS-GATE.** The identity-approval gate was mismatch-only in the legacy system — it fired
  rarely, on genuinely ambiguous cases. It now fires on **every separation, both types**. Every
  single separation run stops and waits for a human.
- **D73 pause-until-done.** For the length of the rebuild the operator does *all* HR work manually.
  When workflows come back one at a time, their attention is already saturated.

Add the obligations that already existed — parked writes needing typed present/absent resolution
(D44), OCR approval gates, rejected member rows, identity-approval resolutions, and now
non-terminal runs blocking a version bump (D80 rule 3) — and the operator has a genuine **work
queue**. Nobody owns it.

What exists instead is a *notification* model (D86: gate/parked/failed → Ping) and per-run status
(row-model D1: `Waiting on you` is one of eight statuses). Those answer "something happened" and
"this row needs you." Neither answers the question the operator actually asks:

> **"What is waiting on me right now, what is most urgent, and can I clear several at once?"**

### The failure mode if it stays unowned

The system that produced the incidents this rebuild exists to prevent was one where a human under
time pressure made a fast identity decision. ALWAYS-GATE puts a human in that position **more
often, by design**. If the surface presenting those decisions is "filter the queue by status and
click through them one at a time," the volume itself becomes the risk — the rubber-stamping vector
already named in doc 09 §14.6, but at queue scale rather than per-run.

### Sketch of what an owner would design

- **One work-queue projection** — derived from the same single run/queue projection (D81; a second
  count path is already a guard failure, and this must not become one). Every run in a
  human-blocking state, across workflows, with what is being asked and since when.
- **Ordering that is honest about urgency**, not just recency. A **parked write** (an unresolved
  possible-submit against a real HR system) outranks an identity approval, which outranks an OCR
  review, which outranks a rejected row. This is the human analogue of doc 05's `interactive` lane,
  and it should be explicit rather than "sort by date."
- **Safe batching, with a hard exception.** Reviewing 12 OCR records or 12 rejected rows in one
  pass is fine and desirable. **Identity approvals must not be batch-approvable** — batching is
  exactly the mechanism that converts an ALWAYS-GATE into a rubber stamp. The queue may *group*
  them for navigation; it may not offer "approve all." Doc 09 §14.6's rule (the shape of the
  approve action changes with the decision's risk) extends here.
- **Aging + a can't-miss floor.** A parked write that has waited days is a different object from
  one that parked a minute ago — it should surface differently, and D86's ping/inbox split needs a
  re-ping policy for aged obligations. Today `repeating` is a ping category; make aged-obligation
  re-ping explicit.
- **Owner: doc 12**, which already owns the operator-facing trust surfaces (`explain run`,
  evidence receipts, notifications' human half). It should get a section next to those, and doc 03
  supplies the projection field.

**Size: S.** This is a projection + a surface, not new machinery — it reuses D81's projection, the
eight statuses, and D67's typed gate arms. It is small precisely because the base already carries
the parts; what is missing is that nobody was told to assemble them.

---

## GAP 2 — Kernel self-health (MAJOR)

**The question no doc answers: when the executor is unhealthy but not crashed, how does the
operator find out?** Doc 05 designs lanes, budgets, leases, fairness, and backpressure — the
mechanisms — but observability of those mechanisms is not in its ownership row, and doc 12's
diagnostic categories are about *run* failures, not *kernel* conditions.

Concretely unowned states, all of which are silent today and would be silent in the rebuild:

| Condition | Why it is invisible | Consequence |
|---|---|---|
| **Stuck claim** — a worker died holding a claim; heartbeat lapsed but nothing reclaims loudly | claims are SQLite authority (D14), reclaim is a mechanism | work sits queued forever while the queue looks busy |
| **Outbox depth growing** — the serialized ledger/span projector is behind or wedged | D32/D33 guarantee correctness, not liveness | writes are durable but the ledger and dashboard silently lag reality |
| **Lease starvation** — a context-exclusive UCPath transaction (D36) drains sibling reads for a long time | correct by design | reads appear hung with no explanation |
| **Provider budget exhaustion** — OCR/model pool exhausted (D63 admission) | typed `unavailable` per call | the operator sees per-record failures, not "the pool is empty" |
| **Scheduler saturation** — every lane busy, queue growing | fairness works as designed | indistinguishable from "slow" |

The legacy system has a real answer for *one* slice of this — the per-browser health monitor with
its verdict ladder and refresh→reopen→surface rungs, plus session cards showing per-browser state.
That ports (doc 05 §3.3 references it, and doc 08 §5 already flagged that the verdicts/rungs were
never enumerated — **still true**). But browser health is a subset of kernel health.

**Recommendation.** Doc 05 gains a §"kernel health signals" that enumerates the conditions, their
detection, and their verdict — with the same fail-loud discipline used everywhere else: an
unhealthy kernel is a **visible degraded state**, never a slow-looking normal one. Doc 12 renders
them beside browser health. **Size: S–M.**

---

## GAP 3 — Retention and growth as a system (MAJOR)

Retention *values* are settled (D86: notes 30d, spans 30d, **ledger forever**, artifacts +
checkpoints until purge) and doc 11 preflights free disk. But three streams are unbounded by
design, and Round 8 added a fourth:

1. the **write ledger** — never pruned, deliberately (it is the audit record);
2. **artifacts** — screenshots, downloaded documents, capture photos, diagnostic bundles — until an
   explicit purge;
3. **checkpoints** — until logical item deletion (D14);
4. **the Archive** (D80, new) — every prior-version run's projected row + receipt + evidence
   pointers, kept as self-contained data, and **an app-version bump archives every workflow's runs
   at once**.

Master-plan risk #8 names the hazard ("evidence volume recreates an unreadable log pile") and lists
mitigations, but assigns **no owner**, so no doc is obliged to state a growth model, a warning
threshold, a purge tool's semantics, or what the system does when the disk is nearly full **while a
write is fenced**. That last one is the sharp edge: the write sequence (doc 09 §3 beat ⑦) commits
intent + checkpoint + ledger outbox + span outbox in one SQLite transaction. **If that transaction
cannot commit for want of disk, the behavior must be specified** — it is a fail-closed park, but no
doc says so today, and the failure would arrive at the worst possible moment.

**Recommendation.** Doc 03 (storage owner) gains a retention/growth section: per-stream growth
estimate (bytes per run, per screenshot, per archived run), warning + degraded thresholds tied to
D51's read-only degraded mode, purge semantics (already an offline exact-id command with a receipt,
D49 — extend to artifacts/archive), and the explicit disk-exhaustion-during-fence rule. **Size: S.**
Fold GAP 4 (Archive physical characteristics) into it.

---

## GAP 5 — Single-instance safety (MINOR)

Zero corpus hits for an instance lock. Two dashboard/executor processes against one authority DB is
not hypothetical — it is what happens when the operator starts the app twice, or a stale process
survives. SQLite WAL makes this *safe* at the row level, and D18's key mutex plus D30's permanent
key make double-commit structurally hard, so this is genuinely MINOR rather than a hazard. But
"safe" and "specified" differ: claims, lanes, budgets, and the serialized ledger projector all
assume a single scheduler. **D33 already requires one projector** — that requirement needs an
enforcement mechanism, which is the same lock.

**Recommendation.** Doc 03 states a boot-time single-instance lease on the authority DB (the same
shape as OnBase's cross-process identity lease, D36 — a proven pattern in this codebase), with a
loud refusal and a clear message rather than a silent second scheduler. **Size: S.**

---

## Adversarial self-review of this audit

- **"GAP 1 is dashboard polish, not foundation."** It would be, except it is created by two safety
  decisions (ALWAYS-GATE, pause-until-done) and its failure mode is the rubber-stamping vector doc
  09 §14.6 already treats as a first-class risk. A control whose presentation causes it to be
  ignored is not a control. It is also cheap (S) precisely because the base carries the parts.
- **"Adding sections contradicts the ceremony trims."** The trims (D79) cut *machinery with no
  named consumer* — a DSL pipeline whose only user was its own test, a five-state lifecycle for one
  actor. Every gap here has a named consumer: the operator, on their first migrated workflow. Two
  of the four (GAP 3, GAP 5) are a page each.
- **"This audit could itself be a stale index."** It owns nothing and is dated. Its findings either
  land in an owning doc — at which point this file is history, like doc 08 — or they are explicitly
  declined. The charter's standing rule (a decision is not ratified until it lands in its owner)
  applies to these too.
- **What I did not find, and looked for:** an unowned write path, an unowned identity path, an
  unowned durability path, an unowned config/secret/time path, or a contract with two owners. The
  D1 matrix holds. The round-1 BLOCKERs are genuinely closed.

## Recommended disposition

| Gap | Owner | Size | When |
|---|---|---|---|
| 1 — operator work queue | doc 12 (+ a doc 03 projection field) | S | **before the first migration** (order 0–1) — it is the surface every later workflow's gates land in |
| 2 — kernel self-health | doc 05 (+ doc 12 surface) | S–M | with the executor, Phase 1f; enumerate the browser-health verdicts/rungs at the same time (doc 08 §5's still-open item) |
| 3 — retention/growth (+ 4) | doc 03 | S | Phase 1c, with the storage contract — the disk-exhaustion-during-fence rule belongs to the write sequence |
| 5 — single-instance lease | doc 03 | S | Phase 1c |

Total ≈ **one M of design work.** None of it blocks Phase 0 approval; items 3 and 5 want to land
with 1c, and item 1 wants to land before the first workflow the operator actually uses.
