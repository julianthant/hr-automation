# EID Lookup — Auth Timeline Fixes (Handoff)

## Context

Three fixes were already applied in this session:
- **Fix #1**: Stale pending run removed from JSONL + SIGINT handler added to pool runner ✅
- **Fix #2**: `"crm-only"` branch surfacing CRM-sourced EIDs ✅ (working — Amine shows 10862201, Nacionales shows 10861468)
- **Fix #4a**: Graceful error labeling in searchingStep ✅

**Fix #3 (auth timeline chips) is partially broken** — the chips appear with labels ("UCPath Auth", "CRM Auth") but show "—" for duration instead of actual timing. Three sub-issues remain.

---

## Remaining Issues

### Issue A: Auth step durations show "—" (no timing data)

**What the JSONL looks like now** (the new run, lines 13-26 of the tracker JSONL):

```
L13: pending  Amine   T=21:41:28.762
L16: running  Amine   step="auth:ucpath"   T=21:41:28.764  ← synthetic, 2ms after pending
L17: running  Amine   step="auth:crm"      T=21:41:28.764  ← SAME timestamp as L16
L22: running  Amine   step="searching"     T=21:42:14.463  ← handler starts ~46s later
L25: running  Amine   step="cross-verification"  T=21:42:28.805
L26: done     Amine   T=21:42:31.836
```

**Why "—"**: `computeStepDurations` ([dashboard.ts L869-922](file:///Users/julianhein/Documents/hr-automation/src/tracker/dashboard.ts#L869-L922)) computes duration by measuring the gap between one step's entry and the NEXT step's entry. Because `auth:ucpath` and `auth:crm` have the **exact same timestamp** (both set to `authStartTs`), the auth:ucpath → auth:crm gap is **0ms** and the auth:crm → searching gap absorbs ALL 46 seconds. So:
- `auth:ucpath` → 0ms (shows "—")
- `auth:crm` → 46s (absorbed into "searching" because of the "first step anchored at workflowStartMs" logic)
- Actually, since `auth:ucpath` IS the first step, it gets anchored at `workflowStartMs` (the pending timestamp), making auth:ucpath duration = 2ms and auth:crm duration = 0ms.

Bottom line: the synthetic entries I wrote have no real per-system timing — they both use `authStartTs`. The pool runner has no per-system auth start/end timestamps because it doesn't pass a `SessionObserver` to `Session.launch`.

**How separations achieves working auth timing** (the "Authenticating (4)" chip in the third screenshot):

1. Separations uses `runWorkflow` / sequential `runWorkflowBatch`, NOT shared-context-pool
2. `runWorkflow` calls `withTrackedWorkflow` which creates a `SessionContext` → wires a `SessionObserver` via `buildSessionObserver` ([workflow.ts L188-243](file:///Users/julianhein/Documents/hr-automation/src/core/workflow.ts#L188-L243))
3. The observer fires `onAuthStart(systemId)` → `makeAuthObserver` → `setStep("auth:kuali")` which calls `emit("running", { step: "auth:kuali" })` **inside the tracked envelope** — so the entry gets the current real timestamp
4. When auth for kuali completes and old-kronos starts, the observer fires `setStep("auth:old-kronos")` — the timestamp gap between the two entries gives `computeStepDurations` the real kuali auth duration
5. All 4 auth steps (kuali, old-kronos, new-kronos, ucpath) get properly separated timestamps because they run **sequentially** through `Session.launch`'s `loginWithRetry` loop

The EID lookup pool runner **cannot** use this pattern directly because `Session.launch` happens ONCE for the whole pool, BEFORE any per-item `withTrackedWorkflow` runs. There's no per-item `SessionContext` to wire the observer into at auth time.

---

### Issue B: Instance numbering starts at 2 ("EID Lookup 2, 3, 4" instead of "1, 2, 3")

**Root cause**: `generateInstanceName` ([session-events.ts L222-257](file:///Users/julianhein/Documents/hr-automation/src/tracker/session-events.ts#L222-L257)) scans `sessions.jsonl` for active workflow instances. The stale canceled run's `workflow_start` event for "EID Lookup 1" is still in `sessions.jsonl` (we only deleted the tracker JSONL entry, not the session events). Since "EID Lookup 1" has a start but no end, `generateInstanceName` considers it active and skips to 2.

**Fix**: Either clean up the stale session events for "EID Lookup 1" from `sessions.jsonl`, or (better) make the pool runner emit ONE instance name for the whole pool rather than having each `withTrackedWorkflow` generate its own. This also ties into Issue A — a single pool-level instance could own the auth events.

---

### Issue C: Step durations don't sum to total elapsed

**What the dashboard shows for Lopez, Giselle A**:
- UCPath Auth: — 
- Searching: 51s
- CRM Auth: —
- Cross Verification: 6s
- **Elapsed: 0m 56s**

Sum of visible steps: 51 + 6 = 57s ≈ 56s (rounding). The auth steps contribute 0s, which hides ~46 seconds of real auth time that happened at pool startup. The total elapsed (pending → done) includes auth time, but the timeline chips don't account for it — so the numbers don't tile.

Once Issue A is fixed (auth steps have real durations), the math will tile: `auth:ucpath + auth:crm + searching + cross-verification ≈ elapsed`.

---

## Recommended Architecture

### Approach: Pool-level observer + per-item auth entry injection with real timestamps

1. **Pass a `SessionObserver` to `Session.launch` in the pool runner** — capture per-system auth start/end timestamps:

```ts
// In shared-context-pool.ts
const authTimings: Array<{ systemId: string; startTs: number; endTs: number }> = []
let currentAuthStart = 0

const observer: SessionObserver = {
  onAuthStart: (systemId) => { currentAuthStart = Date.now() },
  onAuthComplete: (systemId) => {
    authTimings.push({ systemId, startTs: currentAuthStart, endTs: Date.now() })
  },
  onAuthFailed: (systemId) => {
    authTimings.push({ systemId, startTs: currentAuthStart, endTs: Date.now() })
  },
}

const parent = await Session.launch(wf.config.systems, {
  ...,
  observer,  // ← add this
})
```

2. **Thread `authTimings` into `runOneItem`** — add a new field to `RunOneItemOpts`:

```ts
// In types or workflow.ts
interface RunOneItemOpts<...> {
  ...
  /** Pool-level auth timings to inject as synthetic step entries. */
  authTimings?: Array<{ systemId: string; startTs: number; endTs: number }>
}
```

3. **In `runOneItem`, emit auth entries with real historical timestamps** — use `trackEvent` directly (not `setStep`, because `setStep` always uses `Date.now()`). Write one `running` entry per auth system with the recorded `startTs`:

```ts
// Inside runOneItem, after the pending emit but before the handler:
if (args.authTimings?.length) {
  for (const { systemId, startTs } of args.authTimings) {
    trackEvent({
      workflow: wf.config.name,
      timestamp: new Date(startTs).toISOString(),
      id: itemId,
      runId,
      status: 'running',
      step: `auth:${systemId}`,
      data: stringifiedSeed,
    }, trackerDir)
  }
}
```

This gives `computeStepDurations` a clean sequence with correctly-spaced timestamps:
```
pending         T=21:41:28  (workflowStartMs)
auth:ucpath     T=21:41:29  (real ucpath auth start)
auth:crm        T=21:41:45  (real crm auth start, after ucpath completed)
searching       T=21:42:14  (handler body starts)
cross-verif     T=21:42:28
done            T=21:42:31
```

Duration computation:
- `auth:ucpath` = T(auth:crm) - T(pending) = 16s (anchored at `workflowStartMs`)
- `auth:crm` = T(searching) - T(auth:crm) = 29s
- `searching` = T(cross-verif) - T(searching) = 14s
- `cross-verif` = T(done) - T(cross-verif) = 3s
- **Total = 16 + 29 + 14 + 3 = 62s ≈ elapsed**

4. **Remove the `preHandler`-based approach** from the current `shared-context-pool.ts` — it's the source of the identical-timestamp problem.

5. **Instance naming** — either:
   - (Quick) Delete session events for the stale "EID Lookup 1" from `sessions.jsonl`
   - (Better) Have the pool runner emit `workflow_start` once for the pool (current behavior generates one per `withTrackedWorkflow` per item = 3 instance names for 3 items)

---

## Files to Change

| File | Changes |
|------|---------|
| [shared-context-pool.ts](file:///Users/julianhein/Documents/hr-automation/src/core/shared-context-pool.ts) | Add `SessionObserver` to `Session.launch` that records per-system auth start/end times. Pass `authTimings` to each `runOneItem` call. Remove the `preHandler`-based auth entry emission. |
| [workflow.ts](file:///Users/julianhein/Documents/hr-automation/src/core/workflow.ts) (`RunOneItemOpts` + `runOneItem`) | Accept optional `authTimings` array. Emit synthetic auth step tracker entries with the real historical timestamps before the handler runs. |
| `.tracker/sessions.jsonl` | (Manual) Clean up stale "EID Lookup 1" workflow_start event so numbering resets to 1. |

---

## Reference: Working Pattern (Separations)

The separations workflow achieves correct auth timing because `Session.launch` + auth run INSIDE the `withTrackedWorkflow` envelope (see [workflow.ts L380-414](file:///Users/julianhein/Documents/hr-automation/src/core/workflow.ts#L380-L414)):

```
withTrackedWorkflow(...)
  → emit("pending")
  → buildSessionObserver(wf, sessionCtx, setStep, emitFailed)
  → Session.launch(systems, { observer })
    → onAuthStart("kuali")  → setStep("auth:kuali")  → emit("running", step="auth:kuali")
    → loginWithRetry(kuali)
    → onAuthComplete("kuali")
    → onAuthStart("old-kronos") → setStep("auth:old-kronos") → emit("running", step="auth:old-kronos")
    → ...
  → handler(ctx, data)
    → ctx.step("kuali-extraction", ...)  → emit("running", step="kuali-extraction")
    → ...
  → emit("done")
```

Each `setStep` call uses `Date.now()` inside the `emit` closure, so every step gets a real timestamp. The pool runner needs to replicate this timeline, but with pre-recorded timestamps since auth already happened by the time per-item processing begins.

---

## Verification Plan

After implementing, re-run the EID lookup and check:
1. **Auth chips show real durations** (not "—")
2. **Durations tile**: `sum(all step durations) ≈ elapsed time`
3. **Instance numbering** starts at 1
4. All 512 tests still pass
