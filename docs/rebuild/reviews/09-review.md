# Adversarial review — 09-write-safety.md (+ 10/11 seams) — 2026-07-18

Verdict: exactly-once is **sound only with amendments** — holds for single-run crash seams, breaks
on same-key concurrent runs and a schema-unchecked recovery backfill. **Not sign-off-ready** until
A1–A3 + the contract-shape/ledger seams close. Resolutions: `../04-reconciliation.md` D17–D22.

## Exactly-once / fail-closed breaks
1. **BLOCKER — same-key concurrent double-file.** Fence PK is `(workflow,item_id,step_id,attempt)`;
   `idempotency_key` is non-unique and beat ① reads only the live HR page, never `write_intents`
   for an in-flight `attempting` row on the same key (09 §189, §204-217). Two runs deriving the
   same key both fence + click before either row renders → duplicate. → **D18** (partial-unique
   mutex on `idempotency_key`; beat ① consults `write_intents` first).
2. **BLOCKER (governance) — 09 overrides the binding memo.** 09 §37-38 upgrades always-park→
   probe-first, but D8 (binding) + doc 02 §5.5/§5.6#2/line364 still say always-park and OQ2 keeps
   the probe open. → **D17** (adopt probe-then-park; amend D8 + doc 02; add `probePolicy`).
3. **MAJOR — backfill bypasses receipt schema (fail-closed leak).** Recovery case 1 copies
   `ProbeVerdict.present.receipt` (`z.unknown()`) without `completion.schema.parse` → `done` with
   an unvalidated receipt (09 §193 vs §352). → **D19** (validate backfilled receipt; fail → park).
4. **MAJOR — "structurally impossible" overclaim.** §12 vs §11's own residual; the incident was a
   single-instant racy read in onboarding, which has NO pending sweep (`ucpath/LESSONS.md:211-212`).
   → **D20** (double-*file* closed; duplicate-*person* is a disclosed residual).
5. **MAJOR — `unverifiableByPage` escape hatch unguarded** (09 §123/§346; doc 10 §3.3 only
   allowlists idempotency, not completion). → **D22** (allowlist+reason ratchet).
6. **MINOR — fence-before-click "unbypassable" overclaim** — no guard asserts the submit routes
   through `mutation.ts`. → **D22** (guard: every mutate impl imports the fence primitive).

## Cross-doc seams (owner → reconciliation)
- Contract shape 09 (`writeSafety.completion` union) vs doc 10 (flat `receipt`) → **D22**, doc 10
  walks the union; no receipt demanded of Kuali/OnBase.
- `ledger/` dir claimed in 09 but absent from its owner doc 03 → **D21**, doc 03 adds it.
- `write_intents` not in doc 03 §2.3 / D14 set → **D21**, add it.
- "never-pruned" cites a 30-day baseline doc 03 hasn't decided (03 line 744; `clean:tracker`
  defaults 7d) → **D21**, doc 03 decides base retention first.
- `probePolicy` claimed adopted in doc 02 but absent → **D17**, doc 02 adds it.
- Port misattribution: the throw is in `clickSaveAndSubmit` (`transaction.ts:855-859`), not
  `waitForTransactionOutcome` → **D22**.

Honest residual (present to operator as-is once A1–A3 close): the probe read can itself lie
(too-early read → `absent` on a still-rendering page — the duplicate-person root cause), mitigated
by ported race-classifiers + live verification, not a mechanical guard. Kuali/OnBase have no machine
receipt; fail-closed there rests on read-back quality. Wrong-DATA (`T002173685`) is out of
write-safety scope — that is doc 02 freshness + the identity-approval gate.
