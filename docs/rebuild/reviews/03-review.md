# Adversarial review — 03-tracker-dashboard.md (2026-07-17)

Verdict: **structurally flawed until reconciliation** — direction sound (spans, server-resolved
projections, first-class outcomes), but no shared event/descriptor/completion contract across docs,
and both flagship mechanisms (lift adapter, completion union) were checked against the OCR happy
path instead of the real kernel/route code. Resolutions: `../04-reconciliation.md`
(D1, D10–D14).

1. **BLOCKER — Docs 02/03 define two incompatible SpanEvent wire contracts** (02: phase start/end,
   path span-ids, attempt suffixes; 03: discriminated union, UUID ids, worker kind,
   discarded/interrupted, retryOf). → D10: 03's union wins, amended with path-style span identity
   `(runId, attempt, spanPath)`; 02 §4 becomes a reference.
2. **BLOCKER — Lift mapping misses the most common terminals; normal operation would
   quarantine-spam.** Unmapped: plain `done` (`src/tracker/tracked-workflow.ts:420`), `failed` with
   real step (`:493`), base `skipped` (`:379`), `interrupted` reclassification
   (`jsonl-core.ts:447-503`), `superseded` (`ocr/prepare.ts:327`), pseudo-step
   `<step>:failed:<err>` (`tracked-workflow.ts:366-368`), approve-failed/ocr-prep-failed; invalid
   archetypes crash the lift (`row-archetype.ts:96-99`). → D12 (re-derive from kernel terminal
   contract; real-day replay fixture, zero quarantines).
3. **BLOCKER — `ReviewThenFanOut` can't express the real approve route.** childShape is derived at
   approve time from launching intent (`approve.ts:236-239`, recovery `:882-884`; oath-upload
   excluded from coordinators, `ocr/shared.ts:25-34`); `deriveItemId` absent (`approve.ts:
   1309-1332`); per-document target consumes per-record's actually-enqueued itemIds
   (`oath.ts:455`, `approve.ts:306`); `completionOverrides.suppress` has no home for oath-upload.
   → D11 (re-derive union from approve.ts/prepare.ts as-built; ordered stages).
4. **BLOCKER — `CompleteOnEnrichment`/`OwnerConsumes` misrepresent verify, i9, oath-upload.**
   verify: two concurrent BLOCKING gated fan-outs patching records mid-run
   (`verify.ts:544-545,604,625`); i9: real enqueue lives in prepare route gated on coordinator
   (`prepare.ts:476-505`) + task-less display-only failed rows (`i9-check-results.ts:406-409,
   508-576`); oath-upload: no spec in registry (`registry.ts:8-14`), oath spec's signer fan-out
   still runs (`approve.ts:265-296`), payload consumed by sibling born-at-upload task via
   `subscribeToApproval` (`oath-upload/handler.ts:114-146`). → D11.
5. **MAJOR — Descriptor ownership circular; two concrete shapes conflict** (03 defers to 01, 01
   defers to 03, 02 actually defines it; statusExtensions kept in 02 vs abolished in 03).
   → D1: doc 02 owns the descriptor; 03's verdict mappings replace statusExtensions and 02 must
   adopt that.
6. **MAJOR — SQLite both "deletable projection" (03) and sole checkpoint authority (02).**
   → D14 (system-of-record for claims+checkpoints; only projection tables rebuildable).
7. **MAJOR — Flip-before-first-migration is an undersold mega-milestone:** ~122 components,
   103 endpoints (23 route files), 5 SSE topics, 5 hard derived-state clusters — all through the
   lift before Phase 2 starts; tension with "old system keeps working." → D13 (scoped flip:
   queue/log/session/wfCounts only; capture/modifier/settings/AI-assist proxied).
8. **MAJOR — "~20 events/run" contradicts 02's per-action spans and 03's own OCR example**
   (today per-page OCR emits zero rows; ~8-12 deduped snapshots/run, 250ms debounce,
   `orchestrator.ts:671-692,1706-1751`); `QueueSurfaceWire.members` re-serializes ~5-8k-field
   trees per tick on 100-member ops. → D10 (action spans → notes stream; member ids + deltas).
9. **MAJOR — Lift fabricates work and resurrects deleted runs; post-cutover throw = read-path
   outage.** Task-less rows get fabricated run.claimed/worker spans; raw-entry reads bypass
   deletion tombstones (`deletions/visible.ts:72-110`); one straggling old daemon kills projection
   for all workflows. → D12 (lift from visible-entries layer; quarantine, never throw; no
   fabricated spans).
10. **MAJOR — Real gates outside OCR unmodeled.** EID/identity-approval is a `done` row +
    `data.eidApproval` (`domain/identity-approval.ts:12-40`) — lifts as completed, losing an
    operator gate; standalone OCR awaiting-approval has no parentRunId so the delegated-only rule
    opens no gate (`prep-rows.ts:29-41`); reused runIds / same-runId re-pends break "span opened
    and closed exactly once" (`row-lifecycle-debug.ts:344-360`). → D12 + D10 (span identity
    includes attempt; per-workflow gate enumeration in descriptors).
11. **MINOR — Wire gaps:** QueueSurfaceWire lacks traceId, timestamps, dry-run mode; SpanPatched
    references a descriptor detail-field schema §3 doesn't define; log lines now need a second
    grep in `notes/` (doc must say so).
12. **MINOR — Naming/semantics drift across docs** (task ids, `system:"gemini"` outside the closed
    SystemId, dry-run home, retry notation). → D2, D4, D6, D10.
