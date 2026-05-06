# Plan C — OCR Fan-Out Unification (Pathfinder U1)

> **For agentic workers:** This plan is structured for **subagent-driven execution**. The orchestrator (Opus) dispatches one Sonnet subagent per Task. The orchestrator does NOT review subagent diffs between tasks. Final review is by Codex over the combined diff (after all three plans land), per `~/.claude/CLAUDE.md`.

**Goal:** Eliminate ~150 lines of duplicated fan-out orchestration in `src/workflows/ocr/orchestrator.ts` by extracting a private `runFanOutPhase()` function. The two existing fan-out blocks (active-check at lines ~605–750, eid-lookup at lines ~809–955) collapse onto one parameterized call site each.

**Architecture:** `runFanOutPhase` lives in `orchestrator.ts` as a private async function — NOT a separate file. The function is large but belongs with its context (extracting it into `src/workflows/ocr/fan-out.ts` would force exporting too much internal record-patching glue). Behavior is byte-identical; the per-kind difference (target builder, patch function, child workflow name, override hooks) is captured in a parameter object.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Source Pathfinder artifacts:**
- `PATHFINDER-2026-05-06/02-duplication-report.md` — finding A1
- `PATHFINDER-2026-05-06/03-unified-proposal.md` — section U1
- `PATHFINDER-2026-05-06/04-handoff-prompts.md` — Prompt 1

**Branch & worktree:**
- Branch off `master` (clean — not from `codex/active-check-dry-run-ocr-e2e`).
- Recommended: `git checkout -b pathfinder/plan-c-ocr-fan-out master`.
- Worktree recommended (`git worktree add ../hr-automation-plan-c pathfinder/plan-c-ocr-fan-out master`).

**Risk profile:** MEDIUM. `orchestrator.ts` is one of the trickiest files in the repo. The two fan-out blocks branch on multiple `_override` test escape hatches; preserving every branch is critical or OCR tests will silently regress. Trust the existing test suite (`tests/unit/workflows/ocr/`).

**Parallelism:**
- **Within this plan:** One task (single big extraction). No parallelism within. Note: if mid-task the subagent uncovers complexity that requires multiple sub-investigations (e.g. divergence between the two blocks beyond what the Pathfinder report catalogued), it should **flag back to the orchestrator** rather than try to absorb it. That's an "escalation" case per `~/.claude/CLAUDE.md`.
- **Across plans (Plans A / B / C):** Plan C touches `src/workflows/ocr/orchestrator.ts` only. Disjoint from Plans A and B. All three can run in parallel sessions.

**Anti-pattern guards:**
- DO NOT create a new file for `runFanOutPhase` — it's a private helper in `orchestrator.ts`.
- DO NOT introduce a class or registry for fan-out phases — a plain function with opts is sufficient.
- DO NOT remove the `_enqueueActiveCheckOverride` / `_enqueueEidLookupOverride` / `_createActiveCheckDependencyBatchOverride` / `_createEidLookupDependencyBatchOverride` / `_scheduleDependencyTickOverride` / `_disableSqliteDependencies` escape hatches. Tests use them.
- DO NOT change the `watchChildRuns` API or the call shape — just route through the new function.
- DO NOT change the `emitSnapshot` call shape or argument order.
- DO NOT inline the `patchOcrRecordFromActiveCheckOutcome` / `patchOcrRecordFromEidLookupOutcome` helpers; they stay external and get passed in as params.
- DO NOT add comments explaining what the new function does step-by-step. The function is large but readable from its parameter shape.

---

## Task 1 — U1: Extract `runFanOutPhase`

**Subagent model:** Sonnet. **If the subagent reports unexpected divergence between the two blocks, escalate to a new orchestrator session per `~/.claude/CLAUDE.md` complexity-escalation rule.**

**Goal:** Single private function `runFanOutPhase(opts)` invoked twice — once for active-check, once for eid-lookup. Each invocation passes the per-kind specifics; the shared scaffolding (dependency batch creation, scheduler wake, `ensureDaemonsAndEnqueue` invocation, watchChildRuns fallback IIFE, record patching loop, snapshot emission) lives in the helper.

**Files:**
- Modify: `src/workflows/ocr/orchestrator.ts` only.

### Steps

- [ ] **Step 1.1: Confirm baseline tests green.**

```bash
cd /Users/julianhein/Documents/hr-automation
npm run typecheck:all
npm run test -- tests/unit/workflows/ocr
npm run test:architecture
```

Expected: green. If not, STOP and report — do not refactor over a red baseline.

Capture the test count for comparison after the refactor:

```bash
npm run test -- tests/unit/workflows/ocr 2>&1 | tail -5
```

- [ ] **Step 1.2: Read both fan-out blocks fully and diff them.**

```bash
sed -n '595,755p' src/workflows/ocr/orchestrator.ts > /tmp/active-check-block.ts
sed -n '800,960p' src/workflows/ocr/orchestrator.ts > /tmp/eid-lookup-block.ts
diff -u /tmp/active-check-block.ts /tmp/eid-lookup-block.ts | head -200
```

The Pathfinder report (`02-duplication-report.md` finding A1, `03-unified-proposal.md` U1) catalogs the per-kind differences:
1. **Target builder** — `buildActiveCheckTargets` vs `buildLookupTargets`. Different fields on the `FanOutTarget` shape.
2. **`createDependencyBatch` closure** — `createOcrActiveCheckDependencyBatch` vs `createOcrEidLookupDependencyBatch` (same shape, different impl).
3. **`_createDependencyBatchOverride`** test hook — `opts._createActiveCheckDependencyBatchOverride` vs `opts._createEidLookupDependencyBatchOverride`.
4. **Record patching function** — `patchOcrRecordFromActiveCheckOutcome` vs `patchOcrRecordFromEidLookupOutcome`.
5. **`patchOcrRecordUnresolved`** — same function for both, called with different reason strings.
6. **Child workflow name** — `"active-check"` vs `"eid-lookup"`.
7. **Enqueue override** — `_enqueueActiveCheckOverride` vs `_enqueueEidLookupOverride`. Different SHAPE (active-check passes `{ emplId, itemId, taskRole, originWorkflow, taskGroupId }`; eid-lookup passes a different field set — read the actual code to capture exactly).
8. **`ensureDaemonsAndEnqueue` workflow argument** — `activeCheckWorkflow` vs `eidLookupCrmWorkflow` (or similar).
9. **`inputs` shape** — different per kind. Active-check is `{ emplId, keepNonHdh, taskRole, originWorkflow, taskGroupId }`. Eid-lookup is different.
10. **`emitSnapshot` step name** — `"active-check"` vs `"eid-lookup"`. The "running" call is identical structurally.
11. **`itemId` shape** — `ocr-active-${runId}-r${index}` (with `-a${ordinal}` when there's >1 active check per record) vs `ocr-eid-${runId}-r${index}` (or whatever the eid-lookup block uses).

If the subagent finds a 12th difference not catalogued above, it must list all the non-catalogued differences in its result and flag the task — do not proceed without orchestrator review. Skip-the-flag and "wing it" is the failure mode this task most needs to avoid.

- [ ] **Step 1.3: Define the `FanOutOpts` type and the helper.**

Insert the type and function at module scope, above the main `runOcrOrchestrator` (or wherever feels natural in the file's existing structure — match the file's style for type-then-function ordering). Skeleton:

```ts
interface FanOutOpts<TItem> {
  kind: 'active-check' | 'eid-lookup'
  childWorkflow: 'active-check' | 'eid-lookup'
  enqueueItems: TItem[]
  /** Per-itemId resolver used by the watchChildren loop to find the originating index in `records`. */
  itemIdToRecordIndex: (item: TItem) => number
  /** Per-record patching function, called for each terminal child outcome (running). */
  patchRecord: (records: OcrRecord[], recordIndex: number, outcome: ChildOutcome) => void
  /** Called when a child does NOT return within the timeout window. */
  patchUnresolved: (records: OcrRecord[], recordIndex: number, reason: string) => void
  /** Builds the inputs for ensureDaemonsAndEnqueue per child. */
  buildEnqueueInputs: (items: TItem[]) => unknown[]
  /** Maps inputs back to itemIds so deriveItemId() can resolve them in ensureDaemonsAndEnqueue. */
  inputToItemId: Map<string, string>
  inputKeyForResolve: (input: any) => string  // e.g. inp => inp.emplId ?? ''
  workflowImport: () => Promise<RegisteredWorkflow<any, any>>
  // Test escape hatches:
  enqueueOverride?: (inputs: unknown[]) => Promise<void> | void
  createDependencyBatchOverride?: (args: { parent: ParentRef; children: any[] }) => Promise<void>
  scheduleDependencyTickOverride?: () => Promise<{ ok: boolean; error?: string }>
  // Scheduling + watch:
  createDependencyBatch: (children: any[]) => Promise<void>  // already wraps the override + the real call
  sqliteDependenciesEnabled: boolean
  watchTimeoutMs: number
  parentItemId: string
  parentRunId: string
  formType: string
  taskGroupId: string  // input.sessionId
  // Snapshot + emit:
  emitSnapshot: (records: OcrRecord[], step: string, status: 'running' | 'done', extra: SnapshotExtra) => void
  postFanOutStep: 'awaiting-approval'  // both blocks emit this on completion
  trackerDir: string
  date: string
  records: OcrRecord[]
  failedPages: number[]
  emptyPages: number[]
  pageStatusSummary: PageStatusSummary
}

async function runFanOutPhase<TItem extends { itemId: string; index: number; kind: string }>(
  fanOpts: FanOutOpts<TItem>,
): Promise<void> {
  // 1. Emit running snapshot for this kind.
  fanOpts.emitSnapshot(fanOpts.records, fanOpts.kind, 'running', {
    failedPages: fanOpts.failedPages,
    emptyPages: fanOpts.emptyPages,
    pageStatusSummary: fanOpts.pageStatusSummary,
  })

  // 2. Define the watchChildren fallback IIFE (started later, after enqueue).
  const startFallback = (): void => {
    void (async () => {
      try {
        const outcomes = await watchChildren({
          workflow: fanOpts.childWorkflow,
          expectedItemIds: fanOpts.enqueueItems.map((e) => e.itemId),
          trackerDir: fanOpts.trackerDir,
          date: fanOpts.date,
          timeoutMs: fanOpts.watchTimeoutMs,
          onProgress: (outcome, remaining) => {
            const enq = fanOpts.enqueueItems.find((e) => e.itemId === outcome.itemId)
            if (!enq) return
            fanOpts.patchRecord(fanOpts.records, fanOpts.itemIdToRecordIndex(enq), outcome)
            log.step(`[ocr/bg] ${fanOpts.kind} outcome for rec ${fanOpts.itemIdToRecordIndex(enq) + 1}: status=${outcome.status} → record patched (${remaining} remaining)`)
            fanOpts.emitSnapshot(fanOpts.records, fanOpts.postFanOutStep, 'running', {
              failedPages: fanOpts.failedPages,
              emptyPages: fanOpts.emptyPages,
              pageStatusSummary: fanOpts.pageStatusSummary,
            })
          },
        })
        const seen = new Set(outcomes.map((o) => o.itemId))
        for (const enq of fanOpts.enqueueItems) {
          if (!seen.has(enq.itemId)) {
            fanOpts.patchUnresolved(fanOpts.records, fanOpts.itemIdToRecordIndex(enq), `${fanOpts.kind} did not return within timeout`)
          }
        }
        // Existing per-kind log message lives here. If active-check vs eid-lookup
        // emit different "summary" log lines (verifiedCount vs candidatesCount),
        // pass that as a callback in opts.
        log.success(`[ocr/bg] ${fanOpts.kind} watch complete — ${outcomes.length}/${fanOpts.enqueueItems.length} records checked`)
        fanOpts.emitSnapshot(fanOpts.records, fanOpts.postFanOutStep, 'done', {
          failedPages: fanOpts.failedPages,
          emptyPages: fanOpts.emptyPages,
          pageStatusSummary: fanOpts.pageStatusSummary,
        })
      } catch (err) {
        log.warn(`[ocr/bg] ${fanOpts.kind} watcher errored: ${errorMessage(err)}`)
      }
    })()
  }

  // 3. Branch on enqueueOverride vs real ensureDaemonsAndEnqueue.
  if (fanOpts.enqueueOverride) {
    if (fanOpts.sqliteDependenciesEnabled && fanOpts.createDependencyBatchOverride) {
      try {
        await fanOpts.createDependencyBatch(/* children built per-kind */)
      } catch (err) {
        log.warn(`[ocr] ${fanOpts.kind} SQLite dependency setup failed; falling back to watchChildRuns: ${errorMessage(err)}`)
      }
    }
    await fanOpts.enqueueOverride(fanOpts.buildEnqueueInputs(fanOpts.enqueueItems))
  } else {
    const wf = await fanOpts.workflowImport()
    const inputs = fanOpts.buildEnqueueInputs(fanOpts.enqueueItems)
    // ... ensureDaemonsAndEnqueue logic with onPreparedItems callback for SQLite dep batch ...
  }

  // 4. Always start fallback watcher (it's safe even when SQLite deps are running —
  //    watchChildren tolerates double-watching and SQLite deps are a faster signal).
  startFallback()
}
```

The skeleton above is **a guide, not a copy-paste target.** The subagent must read the actual source carefully — both `_enqueueOverride` branches have nuances (the `_enqueueEidLookupOverride` branch in the active-check block at line ~714 logs `"active-check enqueue skipped by test override"` because older eid-lookup tests stubbed only eid-lookup enqueue and would unintentionally spawn a real active-check daemon). Preserve every branch exactly.

- [ ] **Step 1.4: Replace the active-check fan-out block.**

Lines ~597–~750 in the current `orchestrator.ts` become:

```ts
if (activeCheckTargets.length > 0) {
  log.step(`[ocr] enqueuing ${activeCheckTargets.length} active-check(s) for records that already have EIDs (skipped ${records.length - countTargetRecords(activeCheckTargets)} record(s) — no EID yet or already verified)`)
  activeCheckTargets.forEach((t) => {
    log.step(`[ocr] active-check target rec ${t.index + 1}: kind=${t.kind} eid=${targetEid(t, spec)}`)
  })

  const activeTargetsByRecord = countTargetsByRecord(activeCheckTargets)
  const activeEnqueueItems = activeCheckTargets.map((t, ordinal) => ({
    record: t.rec,
    index: t.index,
    kind: t.kind,
    eid: targetEid(t, spec),
    itemId: activeTargetsByRecord.get(t.index)! > 1
      ? `ocr-active-${runId}-r${t.index}-a${ordinal}`
      : `ocr-active-${runId}-r${t.index}`,
  }))

  await runFanOutPhase({
    kind: 'active-check',
    childWorkflow: 'active-check',
    enqueueItems: activeEnqueueItems,
    itemIdToRecordIndex: (it) => it.index,
    patchRecord: patchOcrRecordFromActiveCheckOutcome,
    patchUnresolved: patchOcrRecordUnresolved,
    buildEnqueueInputs: (items) => items.map((e) => ({ emplId: e.eid, keepNonHdh: true, taskRole: 'child', originWorkflow: 'ocr', taskGroupId: input.sessionId })),
    enqueueOverride: opts._enqueueActiveCheckOverride
      ? (inputs) => opts._enqueueActiveCheckOverride!(inputs as any)
      : opts._enqueueEidLookupOverride
        ? () => { log.step('[ocr] active-check enqueue skipped by test override') }
        : undefined,
    createDependencyBatchOverride: opts._createActiveCheckDependencyBatchOverride,
    scheduleDependencyTickOverride: opts._scheduleDependencyTickOverride,
    workflowImport: async () => (await import('../active-check/index.js')).activeCheckWorkflow,
    sqliteDependenciesEnabled: process.env.OCR_SQLITE_DEPENDENCIES !== '0' && !opts._disableSqliteDependencies,
    watchTimeoutMs: opts.eidLookupTimeoutMs ?? 60 * 60_000,
    parentItemId: id,
    parentRunId: runId,
    formType: spec.formType,
    taskGroupId: input.sessionId,
    emitSnapshot,
    postFanOutStep: 'awaiting-approval',
    trackerDir,
    date,
    records,
    failedPages,
    emptyPages,
    pageStatusSummary,
  })
}
```

The exact field/parameter list depends on what `runFanOutPhase` ends up needing once the implementation is finalized in Step 1.3. **Keep the helper's parameter list flat — no nested config objects beyond what's syntactically convenient.** If the param list grows beyond ~20 fields, the subagent should flag that the abstraction may be wrong shape and check with the orchestrator.

- [ ] **Step 1.5: Replace the eid-lookup fan-out block.**

Same pattern as Step 1.4, applied to lines ~809–~955. Use:
- `kind: 'eid-lookup'`
- `childWorkflow: 'eid-lookup'`
- `patchRecord: patchOcrRecordFromEidLookupOutcome`
- The eid-lookup-specific `enqueueOverride`, `createDependencyBatchOverride`, `workflowImport`, and `buildEnqueueInputs`.
- The eid-lookup-specific `itemId` shape (read the current code; do NOT guess).

- [ ] **Step 1.6: Verify.**

```bash
npm run typecheck:all
npm run test -- tests/unit/workflows/ocr
npm run test
npm run test:architecture
```

Test count must match the baseline captured in Step 1.1. Behavior must be byte-identical — the same emit-snapshot calls in the same order with the same arguments, the same log lines (modulo `${kind}` template substitution for kind-specific labels), the same `_override` branches.

If a test fails:
- The most common cause is a missed `_override` branch. Re-read the original block; ensure every conditional path is preserved.
- The second most common cause is an `itemId` shape mismatch (active-check uses `r${index}-a${ordinal}` when there's >1 active check per record; eid-lookup uses a different shape).
- The third most common cause is `emitSnapshot` arg-order drift.

- [ ] **Step 1.7: Commit.**

```bash
git add src/workflows/ocr/orchestrator.ts
git commit -m "$(cat <<'EOF'
refactor(ocr): extract runFanOutPhase shared by active-check and eid-lookup

Two near-identical fan-out blocks in orchestrator.ts (~150 lines each)
collapse onto one private async function. The per-kind specifics —
target builder, patch function, child workflow name, override hooks —
move into a parameter object; the shared scaffolding (dependency batch
creation, scheduler wake, ensureDaemonsAndEnqueue, watchChildRuns
fallback IIFE, record patching loop, snapshot emission) lives once.

All test override hooks (_enqueueActiveCheckOverride,
_enqueueEidLookupOverride, _createActiveCheckDependencyBatchOverride,
_createEidLookupDependencyBatchOverride, _scheduleDependencyTickOverride,
_disableSqliteDependencies) are preserved. No public API change.
EOF
)"
```

---

## Final verification (after the task)

```bash
npm run typecheck:all
npm run test
npm run test:architecture
git log --oneline master..HEAD
```

Expected: 1 commit ahead of master, all tests green. Test count for `tests/unit/workflows/ocr` matches the Step 1.1 baseline.

If any test fails and the orchestrator can't determine the cause from the diff alone, **escalate to a new orchestrator session** (per `~/.claude/CLAUDE.md`) — `orchestrator.ts` complexity may have hidden a divergence the Pathfinder report missed.

**Stop here.** Do NOT open a PR yet — wait for Plans A and B to complete and Codex final review.
