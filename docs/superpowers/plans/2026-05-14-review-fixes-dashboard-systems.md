# Code Review Fixes — Dashboard + Systems Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user is running this inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every correctness, performance, and simplification finding from the 2026-05-14 codebase review for `src/dashboard/` (React SPA) and `src/systems/` (Playwright drivers, selector registries).

**Architecture:** Sequential per-task work on master. Correctness first (real bugs), then performance (virtualization + memoization + bundle), then simplifications (shared components, helpers, dead code). The two halves don't share files, so dashboard tasks and systems tasks could in principle be parallelized — but inline execution keeps them sequential to keep diffs reviewable.

**Tech Stack:** React 19, TypeScript, Vite, shadcn/ui, Tailwind, TanStack Virtual, Playwright, PeopleSoft / Salesforce / Kendo DOM idioms.

**Verification per task:**
```bash
npm run typecheck && npm run test && npm run test:architecture
```

For dashboard-visual changes, also run `npm run dashboard` and exercise the affected feature in a browser before committing.

---

## Phase A — Dashboard correctness (real bugs)

### Task A1: App.tsx `|| true` debug leftover

**File:** `src/dashboard/App.tsx:625`

- [ ] **Step 1:** Open the file. Locate `wantsPreview` declaration:

```tsx
// Before
const wantsPreview =
  isPrepEntry && (reviewingPrepId === (selectedEntry?.runId ?? selectedEntry?.id) || true);

// After
const wantsPreview =
  isPrepEntry && reviewingPrepId === (selectedEntry?.runId ?? selectedEntry?.id);
```

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Open dashboard, select an OCR-prep entry, confirm Preview tab activates when `reviewingPrepId` is set and stays inactive otherwise.
- [ ] **Step 4:** Commit: `fix(dashboard): remove debug || true in wantsPreview`.

### Task A2: App.tsx default export → named

**Files:** `src/dashboard/App.tsx:84`, `src/dashboard/main.tsx`

- [ ] **Step 1:** Change `export default function App()` to `export function App()`. Update `main.tsx` import from `import App from "./App"` to `import { App } from "./App"`.
- [ ] **Step 2:** Run `npm run test:architecture` — the no-default-exports guard should now pass for the dashboard area too.
- [ ] **Step 3:** Run `npm run dashboard` and confirm the SPA renders.
- [ ] **Step 4:** Commit: `fix(dashboard): convert App default export to named to satisfy architecture guard`.

### Task A3: useEntries double-setState per tick

**File:** `src/dashboard/components/hooks/useEntries.ts:86-89,127-129`

- [ ] **Step 1:** Open the file. The setters `setWorkflows`, `setWfCounts`, `setFailureCounts` are called twice per SSE tick — once unconditionally at lines 86-89 (before the hash guard), once inside the hash-changed branch at lines 127-129. Remove the second block (lines 127-129) — the first block already updates on every tick which is correct.
- [ ] **Step 2:** Add a unit test (`tests/unit/dashboard/use-entries.test.ts`) that mocks the SSE source and asserts setters are called exactly once per delivery.
- [ ] **Step 3:** Run `npm run test -- tests/unit/dashboard`.
- [ ] **Step 4:** Commit: `fix(dashboard): drop duplicate setState block in useEntries SSE handler`.

### Task A4: LogStream initialTab reset on clear

**File:** `src/dashboard/components/log-panel/LogStream.tsx:99-103`

- [ ] **Step 1:** Replace:

```tsx
useEffect(() => {
  if (initialTab) setFilter(initialTab);
}, [initialTab]);
```

with:

```tsx
useEffect(() => {
  setFilter(initialTab ?? "all");
}, [initialTab]);
```

So clearing `initialTab` (e.g., user deselects an OCR-prep entry) resets the tab back to `all` instead of stranding the user on Preview.

- [ ] **Step 2:** Run `npm run dashboard`, select an OCR-prep entry (Preview opens), deselect it, confirm tab reverts.
- [ ] **Step 3:** Commit: `fix(dashboard): LogStream filter resets when initialTab clears`.

### Task A5: FailureBell `total` deps fetch loop

**File:** `src/dashboard/components/navigation/FailureBell.tsx:64`

- [ ] **Step 1:** Remove `total` from the `useEffect` dependency array. The current deps `[open, date, total]` cause `/api/failures` to re-fetch every SSE tick that changes failure counts while the popover is open.

```tsx
// Before
useEffect(() => {
  if (!open) return;
  // ... fetch /api/failures ...
  setReadCount(total);
}, [open, date, total]);

// After
useEffect(() => {
  if (!open) return;
  // ... fetch /api/failures ...
  setReadCount(total);
}, [open, date]);
// eslint-disable-next-line react-hooks/exhaustive-deps — total is intentionally captured at open-transition only
```

If ESLint is configured strictly, prefer storing `total` in a ref and reading it inside the effect.

- [ ] **Step 2:** Open dashboard, trigger failures via a running workflow, click the FailureBell, confirm `/api/failures` is hit once per open (not once per SSE tick).
- [ ] **Step 3:** Commit: `fix(dashboard): FailureBell stops refetching /api/failures on every SSE tick`.

### Task A6: useTelegramToasts reconnect ref reset

**File:** `src/dashboard/components/hooks/useTelegramToasts.ts:76`

- [ ] **Step 1:** Replace the no-op `onError` callback with:

```ts
onError: () => {
  initializedRef.current = false;
},
```

Match the reset pattern from `useLogs` / `useRunEvents`. This re-enables the first-tick guard on reconnect.

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(dashboard): useTelegramToasts resets first-tick guard on SSE reconnect`.

### Task A7: useNow / useQueueDepth HMR cleanup

**Files:** `src/dashboard/components/hooks/useNow.ts:3-4`, `src/dashboard/components/hooks/useQueueDepth.ts:14-17`

- [ ] **Step 1:** Add HMR cleanup to both module-level singletons:

```ts
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (intervalId) clearInterval(intervalId);
    subscribers.clear();
  });
}
```

- [ ] **Step 2:** Run `npm run dashboard` in dev mode, force a hot reload (save the file), confirm no duplicate ticks.
- [ ] **Step 3:** Commit: `fix(dashboard): HMR cleanup for useNow + useQueueDepth singletons`.

### Task A8: Delete StepPipeline dead cache branch

**File:** `src/dashboard/components/log-panel/StepPipeline.tsx:355,472-497`

- [ ] **Step 1:** Remove the `const isCached = false` constant at line 355.
- [ ] **Step 2:** Remove the entire `{false && (...)}` block at lines 472-497.
- [ ] **Step 3:** Walk through the rest of the file removing any remaining branches gated on `isCached` (lines 368-418 per the review). Use `rg "isCached" src/dashboard/components/log-panel`.
- [ ] **Step 4:** Run `npm run dashboard` and confirm StepPipeline still renders normally.
- [ ] **Step 5:** Commit: `chore(dashboard): remove dead isCached branch from StepPipeline`.

---

## Phase B — Dashboard performance

### Task B1: Cap useLogs rawLogs window

**File:** `src/dashboard/components/hooks/useLogs.ts:68`

- [ ] **Step 1:** Define `const RAW_LOGS_CAP = 5000` at top of module. Update the setter:

```ts
setRawLogs((prev) => {
  const merged = [...prev, ...newEntries];
  if (merged.length <= RAW_LOGS_CAP) return merged;
  return merged.slice(merged.length - RAW_LOGS_CAP);
});
```

- [ ] **Step 2:** Add a unit test confirming the cap holds.
- [ ] **Step 3:** Run `npm run test -- tests/unit/dashboard`.
- [ ] **Step 4:** Commit: `perf(dashboard): cap useLogs rawLogs at 5000 entries`.

### Task B2: Virtualize LogStream

**File:** `src/dashboard/components/log-panel/LogStream.tsx:277`

- [ ] **Step 1:** Verify `@tanstack/react-virtual` is already in `package.json` (per the dashboard CLAUDE.md). If not, `npm install @tanstack/react-virtual`.
- [ ] **Step 2:** Replace the `displayed.map(...)` flat render with a virtualized container:

```tsx
import { useVirtualizer } from "@tanstack/react-virtual";

const parentRef = useRef<HTMLDivElement>(null);
const virtualizer = useVirtualizer({
  count: displayed.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 28,  // tune per row height
  overscan: 20,
});

return (
  <div ref={parentRef} className="h-full overflow-auto">
    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const row = displayed[vi.index];
        return (
          <div
            key={row.id ?? vi.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${vi.start}px)`,
            }}
          >
            {/* original row JSX */}
          </div>
        );
      })}
    </div>
  </div>
);
```

- [ ] **Step 3:** Run `npm run dashboard`. Select an entry with many logs (run a workflow that produces 500+ lines), scroll, confirm smooth scroll and CPU usage drops.
- [ ] **Step 4:** Confirm copy-on-click and hover affordances still work.
- [ ] **Step 5:** Commit: `perf(dashboard): virtualize LogStream with TanStack Virtual`.

### Task B3: Virtualize QueuePanel (conditional)

**File:** `src/dashboard/components/queue-panel/QueuePanel.tsx`

- [ ] **Step 1:** Inspect the queue size in production. If the queue routinely exceeds ~50 visible rows, virtualize. Otherwise, skip this task and add a comment in the file noting the deferral.
- [ ] **Step 2:** If virtualizing, apply the same TanStack Virtual pattern as Task B2 to the `visibleGroupSurfaces` + `visibleSingleRowSurfaces` render loops. Each row's `EntryItem` keeps its `memo` comparator.
- [ ] **Step 3:** Run `npm run dashboard`, exercise queue with many items.
- [ ] **Step 4:** Commit: `perf(dashboard): virtualize QueuePanel when queue exceeds threshold` OR `chore(dashboard): defer QueuePanel virtualization (queue size below threshold)`.

### Task B4: Stabilize App.tsx displayNames Map identity

**File:** `src/dashboard/App.tsx:164-510`

- [ ] **Step 1:** Find the `displayNames` Map construction. Wrap in a memoized stabilizer:

```ts
const displayNamesRef = useRef<Map<string, string>>(new Map());
const displayNames = useMemo(() => {
  const next = buildDisplayNameMap(...);
  const prev = displayNamesRef.current;
  if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) {
    return prev;  // preserve identity
  }
  displayNamesRef.current = next;
  return next;
}, [/* deps */]);
```

This way the `EntryItem` memo comparator's `prev.displayNames !== next.displayNames` check returns false when content is unchanged, avoiding re-renders of every row on every SSE tick.

- [ ] **Step 2:** Run `npm run dashboard`. Open React DevTools profiler; record a 5-second window with a running workflow; confirm `EntryItem` re-renders drop.
- [ ] **Step 3:** Commit: `perf(dashboard): stabilize displayNames Map identity across SSE ticks`.

### Task B5: useEntries SSE hash performance

**File:** `src/dashboard/components/hooks/useEntries.ts:95`

- [ ] **Step 1:** Replace the `raw.map(...).join(";")` allocation with a single-pass `+=` accumulator:

```ts
let hash = "";
for (const r of raw) {
  hash += `${r.id};${r.runId ?? ""};${r.status};${r.timestamp};${(r as WithFirstLog).firstLogTs ?? ""};`;
}
```

Or, if the SSE source delivers a `lastEventId` or version per tick, compare that instead and skip hashing entirely.

- [ ] **Step 2:** Run `npm run dashboard` and profile. Confirm CPU per SSE tick drops measurably with 100+ entries.
- [ ] **Step 3:** Commit: `perf(dashboard): single-pass entry hash in useEntries`.

### Task B6: LogPanel sibling fetch via SSE

**File:** `src/dashboard/components/log-panel/LogPanel.tsx:104-152`

- [ ] **Step 1:** The current 2s interval polling `Promise.all(members.map(fetch /api/runs))` while any sibling is running is replaceable by subscribing to a runs SSE topic, or by guarding the refetch:

```tsx
// Minimum fix: only refetch when activeRunId or any sibling's status transitions, not on a wall-clock interval.
useEffect(() => {
  // ... fetch ...
}, [activeRunId, siblingStatusKey]);
```

Where `siblingStatusKey` is a memoized string built from sibling statuses. The SSE-driven `/runs` topic would be ideal but requires a backend change; if that's out of scope, use the dep-change gate.

- [ ] **Step 2:** Open dashboard with multiple running siblings and confirm `/api/runs` is not polled every 2 seconds.
- [ ] **Step 3:** Commit: `perf(dashboard): LogPanel refetches /api/runs on transition, not interval`.

### Task B7: LogStream `all` tab merge optimization

**File:** `src/dashboard/components/log-panel/LogStream.tsx:114-142`

- [ ] **Step 1:** Replace the `merged.sort(...)` on every log/event arrival with a two-pointer merge. Since `logs` and `events` are each individually time-ordered, the merge is O(n+m) instead of O((n+m) log(n+m)).

```ts
const merged = useMemo(() => {
  const result: MergedItem[] = [];
  let i = 0, j = 0;
  while (i < logs.length && j < events.length) {
    if (logs[i].timestamp <= events[j].timestamp) result.push(logs[i++]);
    else result.push(events[j++]);
  }
  while (i < logs.length) result.push(logs[i++]);
  while (j < events.length) result.push(events[j++]);
  return result;
}, [logs, events]);
```

- [ ] **Step 2:** Run `npm run test -- tests/unit/dashboard`.
- [ ] **Step 3:** Commit: `perf(dashboard): two-pointer merge for LogStream all-tab`.

---

## Phase C — Dashboard simplifications (shared components)

### Task C1: Extract IconActionButton

**File:** new `src/dashboard/components/shared/IconActionButton.tsx`

- [ ] **Step 1:** Audit the 8 action-button styling sites:
  - `RetryAllButton.tsx:79-86`
  - `DeleteAllButton.tsx:85-92`
  - `StopAllButton.tsx:87-94`
  - `DaemonBatchRow.tsx:174-181, 196-203`
  - `QueueItemControls.tsx:80-87, 107-114`
  - `CancelRunningButton.tsx:126-133`
  - `shared/RetryButton.tsx:91-108`
  - `shared/DeleteButton.tsx:65-82`

- [ ] **Step 2:** Create `IconActionButton.tsx`:

```tsx
import { cn } from "../../lib/utils.js";

type Size = "sm" | "md";
type Tone = "destructive" | "warning" | "primary" | "muted";

const SIZE_CLASS: Record<Size, string> = {
  sm: "h-6 w-6",
  md: "h-8 w-8",
};

const TONE_CLASS: Record<Tone, string> = {
  destructive: "hover:bg-destructive/15 text-destructive",
  warning: "hover:bg-warning/15 text-warning",
  primary: "hover:bg-primary/15 text-primary",
  muted: "hover:bg-muted text-muted-foreground",
};

export function IconActionButton({
  size = "sm",
  tone,
  pending,
  icon,
  label,
  onClick,
  disabled,
}: {
  size?: Size;
  tone: Tone;
  pending?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled || pending}
      className={cn(
        SIZE_CLASS[size],
        "inline-flex items-center justify-center rounded-md cursor-pointer transition-colors outline-none",
        "disabled:opacity-60 disabled:cursor-wait",
        TONE_CLASS[tone],
      )}
    >
      {pending ? <SpinnerIcon className="h-3.5 w-3.5 animate-spin" /> : icon}
    </button>
  );
}
```

- [ ] **Step 3:** Migrate all 8 sites to use `IconActionButton`. Confirm visual parity in each component.
- [ ] **Step 4:** Run `npm run dashboard` and exercise retry/delete/stop in the queue.
- [ ] **Step 5:** Commit: `refactor(dashboard): shared IconActionButton replaces 8 inline button styling sites`.

### Task C2: Extract usePostAction hook

**File:** new `src/dashboard/components/hooks/usePostAction.ts`

- [ ] **Step 1:** Audit the 9 fetch+toast handlers (`RetryAllButton`, `DeleteAllButton`, `StopAllButton`, `DaemonBatchRow.retryAllInBatch`, `DaemonBatchRow.deleteEntireBatch`, `QueueItemControls` retry/delete, `CancelRunningButton`, `shared/RetryButton`, `shared/DeleteButton`, `terminal-drawer/WorkflowBox`).

- [ ] **Step 2:** Create `usePostAction`:

```ts
import { useState, useCallback } from "react";
import { toast } from "sonner";

type ToastConfig = {
  loading: string;
  success: (body: any) => string;
  partial?: (body: any) => string;
  error: (msg: string) => string;
};

export function usePostAction(endpoint: string, toasts: ToastConfig) {
  const [pending, setPending] = useState(false);

  const run = useCallback(async (body: unknown) => {
    setPending(true);
    const toastId = toast.loading(toasts.loading);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const bodyJson = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = bodyJson?.errors?.[0]?.error ?? bodyJson?.error ?? `HTTP ${res.status}`;
        toast.error(toasts.error(msg), { id: toastId });
        return { ok: false, error: msg };
      }
      const msg = bodyJson?.errors?.length && toasts.partial
        ? toasts.partial(bodyJson)
        : toasts.success(bodyJson);
      toast.success(msg, { id: toastId });
      return { ok: true, body: bodyJson };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(toasts.error(msg), { id: toastId });
      return { ok: false, error: msg };
    } finally {
      setPending(false);
    }
  }, [endpoint, toasts]);

  return { pending, run };
}
```

- [ ] **Step 3:** Migrate the 9 button handlers to use `usePostAction`. Each component becomes ~10 lines instead of 50.

- [ ] **Step 4:** Run `npm run dashboard` and exercise every retry/delete/stop button. Confirm toast messages match prior behavior.
- [ ] **Step 5:** Commit: `refactor(dashboard): shared usePostAction hook collapses 9 fetch+toast handlers`.

### Task C3: Merge useLogs + useRunEvents

**Files:** `src/dashboard/components/hooks/useLogs.ts`, `src/dashboard/components/hooks/useRunEvents.ts`, new `src/dashboard/components/hooks/useSseHistoryStream.ts`

- [ ] **Step 1:** Create `useSseHistoryStream<T>(topic: string, params: Record<string, unknown>, opts?: { collapseFn?: (events: T[]) => T[] })` that contains the shared `prevItemIdRef`, `gotSseData`, first-tick logic, and error-handler reset.

- [ ] **Step 2:** Rewrite `useLogs` to call `useSseHistoryStream("logs", { workflow, id, runId, date })`.
- [ ] **Step 3:** Rewrite `useRunEvents` to call `useSseHistoryStream("runEvents", { workflow, id, runId, date }, { collapseFn: collapseSteps })`.
- [ ] **Step 4:** Run dashboard, open log panel for a running entry, confirm both logs and run-events stream as before.
- [ ] **Step 5:** Commit: `refactor(dashboard): shared useSseHistoryStream hook for logs + runEvents`.

### Task C4: Compose DaemonBatchRow with shared buttons

**File:** `src/dashboard/components/queue-panel/DaemonBatchRow.tsx:66-164`

- [ ] **Step 1:** With `usePostAction` and the shared button components in place, replace `DaemonBatchRow.deleteEntireBatch` with `<DeleteAllButton entries={batchEntries} onDeleted={...} confirm />` and `DaemonBatchRow.retryAllInBatch` with `<RetryAllButton entries={batchEntries} />`.
- [ ] **Step 2:** Run `npm run dashboard`, exercise both buttons on a batch.
- [ ] **Step 3:** Commit: `refactor(dashboard): DaemonBatchRow composes RetryAll + DeleteAll instead of duplicating them`.

---

## Phase D — Dashboard simplifications (components & state)

### Task D1: EntryItem deriveStatusConfig + deriveActiveCheckTag + pickRowTitle

**File:** `src/dashboard/components/queue-panel/EntryItem.tsx:138-201`

- [ ] **Step 1:** Replace the 4-level ternary for `cfg` (lines 144-150) with a `function resolveStatusConfig(entry): StatusConfig` switch.
- [ ] **Step 2:** Replace the 3-state ternary for `activeCheckTag` (lines 186-201) with `function deriveActiveCheckTag(entry)`.
- [ ] **Step 3:** Extract the cancelled-name override (line 138) into `function pickRowTitle(entry, resolvedName, isCancelled)`. The current rule is documented only in a comment two lines above.
- [ ] **Step 4:** Run `npm run dashboard`, confirm row labels and status pills unchanged for running, done, failed, cancelled rows.
- [ ] **Step 5:** Commit: `refactor(dashboard): extract status/tag/title derivations from EntryItem`.

### Task D2: EntryItem memo comparator via entry hash

**File:** `src/dashboard/components/queue-panel/EntryItem.tsx:359-383`

- [ ] **Step 1:** If the SSE producer already exposes a per-entry hash on `useEntries.ts:95-97`, bubble it onto each entry as `_hash` (cast type appropriately or widen `TrackerEntry`). The `memo` comparator then becomes:

```tsx
export default memo(EntryItem, (prev, next) => {
  return prev.entry._hash === next.entry._hash &&
    prev.displayNames === next.displayNames &&
    prev.isSelected === next.isSelected;
});
```

If `_hash` isn't producer-side, build a `getEntryHash(entry): string` helper and call it inside the comparator.

- [ ] **Step 2:** Profile with React DevTools, confirm fewer re-renders.
- [ ] **Step 3:** Commit: `perf(dashboard): EntryItem memo comparator via single hash field`.

### Task D3: QueuePanel pickSurfaces + reorderByIds

**File:** `src/dashboard/components/queue-panel/QueuePanel.tsx:215-263`

- [ ] **Step 1:** Extract:

```ts
function pickSurfaces<K extends QueueGroupSurface["kind"]>(
  surfaces: QueueGroupSurface[],
  kind: K,
): Extract<QueueGroupSurface, { kind: K }>[] {
  return surfaces.filter((s): s is Extract<QueueGroupSurface, { kind: K }> => s.kind === kind);
}

function reorderByIds<T>(items: T[], idFn: (item: T) => string, sortedIds: string[]): T[] {
  const map = new Map(items.map((item) => [idFn(item), item]));
  return sortedIds.map((id) => map.get(id)).filter((x): x is T => x !== undefined);
}
```

Replace the three back-to-back `.filter` calls (each with a type-narrowing predicate) and the two `sortedX surfaces` Map+sort+flatMap passes.

- [ ] **Step 2:** Run `npm run typecheck && npm run dashboard`.
- [ ] **Step 3:** Commit: `refactor(dashboard): QueuePanel pickSurfaces + reorderByIds helpers`.

### Task D4: QueueSortToolbar + QueueLoadingSkeleton + classifier surface order

**Files:** `src/dashboard/components/queue-panel/QueuePanel.tsx:436-440, 464-502, 521-533, 567-569`

- [ ] **Step 1:** Extract the two near-identical toolbar/sort header blocks (lines 464-502) into `<QueueSortToolbar wrapperBg="..." />`. Use in both batch-header and non-batch-header sites.
- [ ] **Step 2:** Extract the inline 6-card skeleton (lines 521-533) into `<QueueLoadingSkeleton />`.
- [ ] **Step 3:** Move the surface ordering logic (lines 436-440) into `queue-surface-classifier.ts`, exposing `orderGroupSurfaces(surfaces): QueueGroupSurface[]`. Same for `resolvedBatchToolbarEntry` + `batchAnchorIsPrep` traversals (lines 166-205) — combine into one `.find()` call.
- [ ] **Step 4:** Run `npm run dashboard` and confirm visual parity.
- [ ] **Step 5:** Commit: `refactor(dashboard): QueuePanel toolbar/skeleton extractions + classifier owns surface order`.

### Task D5: group-row-base cleanups

**Files:** `src/dashboard/components/queue-panel/group-row-base.tsx:31,55,69-99,248-254`

- [ ] **Step 1:** Wrap `useElapsed` + frozen check into `useBatchElapsedLabel(elapsed)` (lines 69-80).
- [ ] **Step 2:** Replace the duplicate `drillInProps` spread onto two children (lines 84-99) with a single `<DrillInButton>` wrapper so only one tab-stop exists.
- [ ] **Step 3:** If `_footerLabelPrefix` (line 55) and `variant` (line 31) prop are genuinely unused for visual differences, drop them. If they're a debug-only `data-` attribute, document with a comment.
- [ ] **Step 4:** Share `formatTime` between `group-row-base.tsx:248-254` and `EntryItem.tsx:166-171` via a new `src/dashboard/components/shared/entry-display.ts` export. Pick one fallback behavior (probably the `try/catch` swallow variant).
- [ ] **Step 5:** Run `npm run dashboard`, exercise group rows in queue.
- [ ] **Step 6:** Commit: `refactor(dashboard): group-row-base helper + drop unused props`.

### Task D6: useEntries WithFirstLog + sort key

**File:** `src/dashboard/components/hooks/useEntries.ts:95-122`

- [ ] **Step 1:** Either widen `TrackerEntry` to include `firstLogTs?: string` directly, or use the `WithFirstLog` cast consistently (the producer enriches at line 111 already). Remove the `as any` cast at line 95-97.
- [ ] **Step 2:** Replace the multi-branch nested-if sort comparator (lines 111-122) with a key function + `toSorted`:

```ts
function entrySortKey(e: WithFirstLog): number {
  const ts = e.firstLogTs ?? e.timestamp;
  return -Date.parse(ts);  // descending
}
const sorted = dedupedBase.toSorted((a, b) => entrySortKey(a) - entrySortKey(b));
```

- [ ] **Step 3:** Add a unit test asserting sort order with mixed `firstLogTs` and `timestamp` keys.
- [ ] **Step 4:** Commit: `refactor(dashboard): useEntries types + sort key`.

### Task D7: EditDataTab pending discriminated union

**File:** `src/dashboard/components/log-panel/EditDataTab.tsx:55-58`

- [ ] **Step 1:** Replace the four sibling `useState` booleans with a single discriminated union (mirrors `QueueItemControls.tsx:21`):

```ts
type Pending = null | "run" | "save" | "refresh";
const [pending, setPending] = useState<Pending>(null);
```

Update every `setPending(true/false)` site to set the specific action label or `null`. Buttons disable when `pending !== null`.

- [ ] **Step 2:** Run `npm run dashboard`, exercise Edit Data → Save, Run, Refresh.
- [ ] **Step 3:** Commit: `refactor(dashboard): EditDataTab discriminated pending state`.

### Task D8: Misc EntryItem cleanups

**File:** `src/dashboard/components/queue-panel/EntryItem.tsx`

- [ ] **Step 1:** Remove `const isRunning = isDaemonRunning` no-op alias (line 139). Update all `isRunning` references to `isDaemonRunning`.
- [ ] **Step 2:** Extract `getRunNumber(entry: TrackerEntry): number` into `src/dashboard/components/shared/entry-display.ts` and use from both `EntryItem.tsx:159-165` and `group-row-base.tsx:82`. Probably `RunSelector.tsx` too.
- [ ] **Step 3:** Collapse the three sibling action-cluster branches (lines 303-329) into `<EntryItemActions entry={entry} ... />` subcomponent. Keep the JSX simple.
- [ ] **Step 4:** Move `STATUS_CONFIG` hex colors (`#4ade80`, `#fbbf24`) to CSS variables (`--success`, `--warning`). Same for `StatPills.tsx:25-28`. Update Tailwind class composition.
- [ ] **Step 5:** Run `npm run dashboard`, confirm color tokens render correctly in dark/light modes.
- [ ] **Step 6:** Commit: `refactor(dashboard): EntryItem cleanups + CSS tokens for status colors`.

### Task D9: StatPills + nested ternaries flatten

**File:** `src/dashboard/components/queue-panel/StatPills.tsx:37,60`

- [ ] **Step 1:** Replace `count = s.key ? counts[s.key] || 0 : entries.length` with an explicit branch or modify `countEntriesByQueueStatus` to include a total under a `null` key.
- [ ] **Step 2:** Replace nested color ternary at line 60 with `(count === 0 && !isActive) ? "text-muted-foreground" : s.color`.
- [ ] **Step 3:** Commit: `refactor(dashboard): StatPills flatten ternaries`.

### Task D10: RetryButton + DeleteButton size-tone tables + JSON.stringify dedup

**Files:** `src/dashboard/components/shared/RetryButton.tsx:45-108`, `src/dashboard/components/shared/DeleteButton.tsx:65-82`, `src/dashboard/components/queue-panel/QueueItemControls.tsx:33`

- [ ] **Step 1:** Replace the `size === "md"` ternaries that pick entire className blocks with `BTN_TONE_MD` / `BTN_TONE_SM` constant lookups (or rely on `IconActionButton` once Task C1 lands).
- [ ] **Step 2:** Extract a `compact({...})` util that omits null/undefined keys, used by `RetryButton.tsx:45-51 + QueueItemControls.tsx:33` for the `JSON.stringify(runId ? {…} : {…})` pattern.
- [ ] **Step 3:** Fix the `iconClass = size === "md" ? "h-3.5 w-3.5" : "h-3.5 w-3.5"` no-op ternary (returns same string both branches): just hardcode `"h-3.5 w-3.5"`.
- [ ] **Step 4:** Commit: `refactor(dashboard): button tone-size lookup tables + compact helper`.

### Task D11: SSE hub debounce review

**File:** `src/dashboard/lib/sse-hub.ts:50-82`

- [ ] **Step 1:** Read the existing `scheduleRebuild` + `queueMicrotask` flow. The perf review notes that mid-session subscribe causes a full reconnect. If the user reports flicker / repeat history-replay during dashboard use, consider sending subscribe/unsubscribe deltas over the existing connection rather than closing + reopening. If not observed in practice, document the limitation in the file header and skip.
- [ ] **Step 2:** Confirm `gotSseData = false` reset in `useLogs` / `useRunEvents` handles the replay correctly post-reconnect.
- [ ] **Step 3:** Commit: `chore(dashboard): document SSE hub reconnect behavior` (if no code change) OR `perf(dashboard): SSE hub delta subscriptions instead of full reconnect`.

### Task D12: CancelRunningButton + DelegationRow indirection

**Files:** `src/dashboard/components/queue-panel/CancelRunningButton.tsx:45-48`, `src/dashboard/components/ocr/DelegationRow.tsx:30-77`

- [ ] **Step 1:** Either inline the `fire` wrapper in `CancelRunningButton` (one-liner indirection) or document why it stays.
- [ ] **Step 2:** Inspect `DelegationRow` — its CLAUDE.md comment says "compatibility wrapper while the shared queue-panel base owns the visual structure." Verify the migration is complete. If so, inline into `QueuePanel.tsx::renderQueueGroupSurface` and delete the file. If not, leave with the existing comment.
- [ ] **Step 3:** Commit: `chore(dashboard): inline cancel/delegation wrappers if migration complete`.

### Task D13: useEntries stableKey + hubParams compact

**Files:** `src/dashboard/components/hooks/useEntries.ts:91-107`, `src/dashboard/components/log-panel/LogPanel.tsx:74-77`, `src/dashboard/components/hooks/useLogs.ts:48-50`, `src/dashboard/components/hooks/useRunEvents.ts:43-44`

- [ ] **Step 1:** Extract a tiny `stableKey(parts: (string | undefined)[]): string` util into `src/dashboard/lib/utils.ts`. Use in `useEntries` hash and `LogPanel.tsx:74-77` siblings sort+join.
- [ ] **Step 2:** Extract a `compact(obj)` util (or reuse Task D10's). Replace the mutable object-building in `useLogs.ts:48-50` and `useRunEvents.ts:43-44`.
- [ ] **Step 3:** Run `npm run test -- tests/unit/dashboard`.
- [ ] **Step 4:** Commit: `refactor(dashboard): shared stableKey + compact utils`.

### Task D14: isEditableFocus → utils

**File:** `src/dashboard/components/queue-panel/QueuePanel.tsx:343-348` → `src/dashboard/lib/utils.ts`

- [ ] **Step 1:** Move the `isEditableFocus(target): boolean` helper to `lib/utils.ts`. Useful for any future keyboard handler.
- [ ] **Step 2:** Commit: `refactor(dashboard): lift isEditableFocus into shared utils`.

### Task D15: EditDataTab empty-state share

**File:** `src/dashboard/components/log-panel/EditDataTab.tsx:65-80`

- [ ] **Step 1:** Two `<div className="flex-1 px-6 py-4 text-sm text-muted-foreground">…</div>` blocks differ only in message. Extract `<EmptyEditState>` or use the existing `EmptyState` primitive (check if there's one already).
- [ ] **Step 2:** Commit: `refactor(dashboard): share EditDataTab empty-state wrapper`.

### Task D16: Dashboard verification sweep

- [ ] **Step 1:** `npm run typecheck && npm run test && npm run test:architecture && npm run lint`
- [ ] **Step 2:** Run `npm run dashboard` for 60+ seconds with at least one workflow running. Watch CPU and memory. Confirm no regressions.
- [ ] **Step 3:** Open React DevTools profiler, record a 5-second window with active SSE. Confirm EntryItem and QueuePanel re-render counts are reasonable.
- [ ] **Step 4:** Commit any cleanups: `chore(dashboard): post-plan-2 verification sweep`.

---

## Phase E — Systems correctness

### Task E1: Replace hardcoded "Julian Zaw" with a selector-driven name lookup

**File:** `src/systems/ucpath/person-org-summary.ts:47`

- [ ] **Step 1:** This is the most surprising finding in the review: a personal name is used as a UI label exclusion list. Read the TODO comment above the constant.
- [ ] **Step 2:** Open `src/systems/ucpath/selectors.ts`. Map a new selector targeting the actual name display element (the sidebar/nav element that the heuristic was working around). Use `playwright-cli` to find the element. Add the selector with `// verified YYYY-MM-DD` comment, JSDoc, and `@tags`.
- [ ] **Step 3:** Rewrite `selectPersonName` to use the new selector directly instead of filtering against the label list. The hardcoded name list can go.
- [ ] **Step 4:** Run `npm run selectors:catalog`.
- [ ] **Step 5:** Append a lesson to `src/systems/ucpath/LESSONS.md` using the format the architecture guard enforces (`**Tried:** / **Failed because:** / **Fix:** / **Tags:**`) documenting why the old heuristic was brittle.
- [ ] **Step 6:** Run `npm run test:architecture`.
- [ ] **Step 7:** Commit: `fix(ucpath): replace hardcoded personal-name exclusion with selector-driven lookup`.

### Task E2: i9/create.ts hardcoded URL → config

**File:** `src/systems/i9/create.ts:86`

- [ ] **Step 1:** Import `I9_URL` from `src/config.ts` at the top of the file. Replace the hardcoded `https://wwwe.i9complete.com/...` URL with `I9_URL.replace("stse.", "wwwe.")` (matching `signer.ts`).
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(i9): derive saveAndContinue URL from config instead of hardcoding`.

### Task E3: old-kronos/navigate.ts dynamic import → static

**File:** `src/systems/old-kronos/navigate.ts:509`

- [ ] **Step 1:** Replace `const { UKG_URL } = await import("../../config.js")` with a top-level `import { UKG_URL } from "../../config.js"`. Move the import to the top of the file.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(old-kronos): static-import UKG_URL in goBackToMain`.

### Task E4: old-kronos/reports.ts dynamic fs imports → static

**File:** `src/systems/old-kronos/reports.ts:310-311`

- [ ] **Step 1:** Replace `await import("fs/promises")` and `await import("fs")` with `import { rename, unlink } from "node:fs/promises"` and `import { existsSync } from "node:fs"` at the top of the file.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(old-kronos): static-import fs in reports.ts`.

### Task E5: old-kronos statusFrame non-null assertion

**File:** `src/systems/old-kronos/reports.ts:185-207`

- [ ] **Step 1:** Read the function. Assign `statusFrame = f` in the same `if (status === "complete")` branch where `myRowId = result.trId` is assigned (not just in the broader `if (result)` block). After the change, the `!` non-null assertion on `statusFrame!` becomes unnecessary — TypeScript can prove it.
- [ ] **Step 2:** Audit the surrounding loop ordering — confirm there's no path where `myRowId` is truthy but `statusFrame` is null.
- [ ] **Step 3:** Run `npm run typecheck && npm run test`.
- [ ] **Step 4:** Commit: `fix(old-kronos): tighten statusFrame assignment to remove non-null assertion`.

### Task E6: ucpath waitForSaveEnabled `as never` cast

**File:** `src/systems/ucpath/transaction.ts:509`

- [ ] **Step 1:** Read the `btn` type. It's typed as `Pick<Locator, "isEnabled" | "waitFor">`. The `as never` cast hides a real signature mismatch. Either:
  - (a) Widen `btn` to `Locator` (the full type) at the call site, or
  - (b) Define the `waitFor` method with the correct overload in the Pick.

Pick (a) unless typing the Pick is genuinely needed for testability.

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(ucpath): drop unsafe as-never cast on waitForSaveEnabled`.

### Task E7: servicenow selectors verified-comment style

**File:** `src/systems/servicenow/selectors.ts`

- [ ] **Step 1:** Convert every `@verified YYYY-MM-DD` JSDoc tag to the inline `// verified YYYY-MM-DD` comment style used by all other systems. The architecture guard (`tests/unit/scripts/selectors-catalog.test.ts`) keys on inline comments.
- [ ] **Step 2:** Run `npm run selectors:catalog` and verify `SELECTORS.md` for servicenow shows verification dates.
- [ ] **Step 3:** Run `npm run test:architecture`.
- [ ] **Step 4:** Commit: `fix(servicenow): use inline verified comment style to satisfy catalog guard`.

### Task E8: old-kronos-reports browser `as never` cast

**File:** `src/workflows/old-kronos-reports/parallel.ts:125-132`

- [ ] **Step 1:** Define the `launchFn` return type explicitly and assert via `satisfies` to verify the shape. Drop the `browser as never`.

```ts
const launchFn: LaunchFnReturning = async (...) => {
  const result = await launchBrowser(...);
  return { browser: result.browser, context: result.context, page: result.page } satisfies LaunchOutput;
};
```

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(workflows): drop browser as-never cast in old-kronos-reports`.

---

## Phase F — Systems: safeClick / safeFill adoption

This is a substantial fanout — the project mandates `safeClick`/`safeFill` for instrumented selector-fallback logging, but no system driver currently calls them. Adoption is mechanical but voluminous.

### Task F1: Adopt safeClick / safeFill in UCPath

**Files:** `src/systems/ucpath/transaction.ts`, `src/systems/ucpath/navigate.ts`, `src/systems/ucpath/personal-data.ts`, `src/systems/ucpath/person-org-summary.ts`, others under `src/systems/ucpath/`

- [ ] **Step 1:** Open `src/systems/common/safe.ts`. Read the signatures of `safeClick(locator, opts?)` and `safeFill(locator, value, opts?)`.
- [ ] **Step 2:** For each `.click({ timeout })` in UCPath system files, replace with `safeClick(locator, { timeout, label: "<short intent>" })`. Same for `.fill(value, { timeout })` → `safeFill(locator, value, { timeout, label })`.
- [ ] **Step 3:** Do NOT change compound selectors like `row.locator("td").nth(1).click(...)` if they're rooted in registry locators with `// allow-inline-selector` comments. Only convert direct selector-function calls.
- [ ] **Step 4:** Run `npm run typecheck && npm run test:architecture`.
- [ ] **Step 5:** Run one workflow end-to-end (e.g., `npm run eid-lookup "Smith, John"`). Watch the dashboard's selector health panel — fallback events should now appear in real time.
- [ ] **Step 6:** Commit: `feat(ucpath): adopt safeClick/safeFill for fallback instrumentation`.

### Task F2: Adopt safeClick / safeFill in CRM, I9, Kuali, Kronos, ServiceNow

**Files:** `src/systems/crm/`, `src/systems/i9/`, `src/systems/kuali/`, `src/systems/new-kronos/`, `src/systems/old-kronos/`, `src/systems/servicenow/`

- [ ] **Step 1:** Repeat the Task F1 pattern across all remaining system drivers.
- [ ] **Step 2:** Run `npm run typecheck && npm run test:architecture`.
- [ ] **Step 3:** Spot-check by running each workflow type at least once.
- [ ] **Step 4:** Commit: `feat(systems): adopt safeClick/safeFill across remaining system drivers`.

---

## Phase G — Systems simplifications (dead code + dedup)

### Task G1: Delete _clearSearch dead function

**File:** `src/systems/ucpath/person-org-summary.ts:488-508`

- [ ] **Step 1:** Confirm `_clearSearch` has zero callers: `rg "_clearSearch" src`. If clean, delete the function and the leading TODO comment.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `chore(ucpath): delete dead _clearSearch helper`.

### Task G2: ucpath transaction.ts waitForSaveEnabled timers/promises

**File:** `src/systems/ucpath/transaction.ts:504-518`

- [ ] **Step 1:** Replace `await new Promise((r) => setTimeout(r, pollMs))` with `await sleep(pollMs)` from `node:timers/promises`. Add the import at top of file.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(ucpath): node:timers/promises in waitForSaveEnabled`.

### Task G3: Drop redundant `log.step("…filled")` echoes

**File:** `src/systems/ucpath/transaction.ts:188-331`

- [ ] **Step 1:** Walk through `fillPersonalData`. Every fill is preceded by `log.step("Filling X...")` and followed by `log.step("X filled")`. After Task F1 / F2 lands `safeFill`, the per-action timing logs come from `safeFill` itself.
- [ ] **Step 2:** Drop the post-fill `log.step("… filled")` echoes (keep the pre-fill intent log). Cuts ~25 lines of redundant log noise.
- [ ] **Step 3:** Run a workflow that exercises personal data fill (`npm run onboarding ...`). Confirm dashboard log panel still shows fill steps.
- [ ] **Step 4:** Commit: `refactor(ucpath): drop redundant post-fill log echoes (safeFill already instruments)`.

### Task G4: Extract extractAssignmentCellsFromBody helper

**File:** `src/systems/ucpath/person-org-summary.ts:338-353, 560-575`

- [ ] **Step 1:** The 16-line `body(frame).evaluate(...)` table-row scan looking for 12+ cells with `buCell` matching `/^[A-Z]{4,5}\d?$/` and `deptCell` filter is reproduced byte-for-byte across `extractSingleResultDetail` and `drillInAndGetDetails`. Extract a private helper `extractAssignmentCellsFromBody(frame): Promise<string[] | null>` and have both callers use it.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `refactor(ucpath): shared extractAssignmentCellsFromBody helper`.

### Task G5: Extract collapseSidebar helper

**Files:** `src/systems/ucpath/person-org-summary.ts:215-246`, `src/systems/ucpath/transaction.ts:38-44`, `src/systems/ucpath/navigate.ts`

- [ ] **Step 1:** Both files run the same `await smartHR.sidebarNavigationToggle(page).click(...); await page.waitForTimeout(1000)` inside a try/catch. Move to `collapseSidebar(page)` in `navigate.ts`. Repoint callers.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(ucpath): shared collapseSidebar helper`.

### Task G6: Collapse old-kronos clickRunReport

**File:** `src/systems/old-kronos/reports.ts:76-134`

- [ ] **Step 1:** Replace the inline duplication of `clickInFrames` + `jsClickText` bodies with:

```ts
async function clickRunReport(page: Page, framesToSearch: Frame[]): Promise<boolean> {
  if (await clickInFrames(page, [...reportsPage.runReportSelectors], framesToSearch)) {
    return true;
  }
  return jsClickText(page, "Run Report", framesToSearch);
}
```

This reduces ~55 lines to ~6. Confirm `jsClickText` and `clickInFrames` exist as shared helpers; if not, extract them first.

- [ ] **Step 2:** Run a Kronos report workflow if env is available.
- [ ] **Step 3:** Commit: `refactor(old-kronos): collapse clickRunReport to two-strategy chain`.

### Task G7: Old-kronos handleReportsPage select-extraction

**File:** `src/systems/old-kronos/reports.ts:444-481`

- [ ] **Step 1:** Step 3 and Step 4 are near-identical 16-line `<select>` enumeration blocks. Extract:

```ts
async function selectInWorkspaceByOptionText(
  wsFrame: Frame,
  predicate: (text: string) => boolean,
): Promise<boolean> { /* ... */ }
```

Cover both Actual/Adjusted (filter by row text) and PDF (filter by option text).

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(old-kronos): shared selectInWorkspaceByOptionText helper`.

### Task G8: Old-kronos getGeniesIframe network-error helper

**File:** `src/systems/old-kronos/navigate.ts:52-119`

- [ ] **Step 1:** Extract `reloadOnNetworkError(page, frame): Promise<void>` consuming the 7-line check at lines 70-76 and 88-95.
- [ ] **Step 2:** Replace the third bare reload at lines 107-118 with a call too (if the semantics match).
- [ ] **Step 3:** Commit: `refactor(old-kronos): shared reloadOnNetworkError helper`.

### Task G9: UCPath readTransactionIdFromDetailPage helper

**File:** `src/systems/ucpath/transaction.ts:519-591, 692-746`

- [ ] **Step 1:** Both `clickSaveAndSubmit` and `findExistingTerminationTransaction` navigate to detail pages and run `bodyText.match(/Transaction ID:\s*(T\d+)/)` with the same fallback. Extract `readTransactionIdFromDetailPage(frame): Promise<string | null>`.
- [ ] **Step 2:** Commit: `refactor(ucpath): shared readTransactionIdFromDetailPage helper`.

### Task G10: UCPath dismiss / extract / settle helpers

**Files:** `src/systems/ucpath/navigate.ts:120-130, 78-83+`, `src/systems/ucpath/job-summary.ts:213-272`, `src/systems/ucpath/transaction.ts:91-119, 527-557`

- [ ] **Step 1:** Hoist `dismissPeopleSoftDialogIcok(page)` from the closure inside `dismissDialog`. Reuse at lines 132-137 and 147-156.
- [ ] **Step 2:** Extract `findFirstRowMatching(page, cellCount, idCellRegex, mapper)` used by both `extractWorkLocation` and `extractJobInfo`. Also share with `findTransactionRowLinkByEid:759-786`.
- [ ] **Step 3:** Extract `settleUcpathPage(page, { idleMs?, timeoutMs? })` consolidating the 8+ `waitForTimeout(5000) + waitForLoadState("networkidle")` repeats across navigate.ts. Cautiously — some sites may have intentionally different wait durations; preserve overrides via options.
- [ ] **Step 4:** Extract `checkErrorBanner(frame): Promise<{ ok: true } | { ok: false; error: string }>` used by `clickCreateTransaction` and `clickSaveAndSubmit`.
- [ ] **Step 5:** Run `npm run typecheck && npm run test:architecture`.
- [ ] **Step 6:** Commit: `refactor(ucpath): consolidate dismiss/extract/settle/banner helpers`.

### Task G11: UCPath tab click helpers

**File:** `src/systems/ucpath/transaction.ts:476-499, 469-485`

- [ ] **Step 1:** `clickEarnsDistTab` and `clickEmployeeExperienceTab` are byte-identical except for the tab name and log label. Collapse to `clickTransactionTab(page, frame, tabName)`. Include `clickJobDataTab` if its post-click settle behavior matches.
- [ ] **Step 2:** Run a workflow that exercises these tabs.
- [ ] **Step 3:** Commit: `refactor(ucpath): collapse near-identical tab-click helpers`.

### Task G12: New-kronos date entry via pressSequentially

**File:** `src/systems/new-kronos/navigate.ts:160-173`

- [ ] **Step 1:** Replace the triple-click + Delete + Home + per-char `waitForTimeout(100)` loop with:

```ts
await inp.fill("");
await inp.pressSequentially(digits, { delay: 100 });
```

Match the Kuali idiom in `fillWithVerify`.

- [ ] **Step 2:** Commit: `refactor(new-kronos): pressSequentially for date entry`.

### Task G13: I9 search.ts batch text content

**File:** `src/systems/i9/search.ts:104-115`

- [ ] **Step 1:** Replace cell-by-cell `await cells.nth(N).textContent()` sequential awaits with `await cells.allTextContents()` (single round-trip).
- [ ] **Step 2:** Commit: `perf(i9): batch cell text retrieval in search results`.

### Task G14: I9 clickWithKendoRecovery helper

**Files:** `src/systems/i9/create.ts:35-40`, `src/systems/i9/search.ts:33,77`, `src/systems/i9/navigate.ts`

- [ ] **Step 1:** Extract `clickWithKendoRecovery(page, locator, label)` consuming the `classifyPlaywrightError` + `snapshotKendoWindows` + re-throw pattern. Three call sites.
- [ ] **Step 2:** Commit: `refactor(i9): shared clickWithKendoRecovery helper`.

### Task G15: Tracker file-registration share

**Files:** `src/systems/old-kronos/reports.ts:345-368`, `src/systems/crm/idocs-download.ts:275-303`, new `src/tracker/files/register-download.ts`

- [ ] **Step 1:** Both functions do `try { dynamic import openStateDb + isStateDbReady + registerLocalFile } catch {}`. Move into `src/tracker/files/register-download.ts` as `registerDownloadedFile({ kind: "kronos-report" | "crm-document", ... })`. Repoint callers.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(tracker): shared registerDownloadedFile helper for kronos+crm`.

### Task G16: Misc systems polish

**Various files (low priority — group into one commit)**

- [ ] **Step 1:** `src/systems/ucpath/navigate.ts:36, 41-49` — Hoist `const probe = frame.locator(processingSelector).first()` once.
- [ ] **Step 2:** `src/systems/crm/idocs-download.ts:115-157` — Verify line-3 `node:fs`/`node:os` prefix style is applied consistently. Add `node:` prefix to any remaining bare imports.
- [ ] **Step 3:** Verify systems CLAUDE.md and LESSONS.md files are still well-formed (`npm run test:architecture`).
- [ ] **Step 4:** Commit: `chore(systems): assorted polish — locator hoisting, node: prefixes`.

### Task G17: Verification sweep

- [ ] **Step 1:** `npm run typecheck:all && npm run test && npm run test:architecture && npm run lint`
- [ ] **Step 2:** Run at least one workflow end-to-end (e.g., `npm run onboarding <test-email>` if you have a test env, or `npm run eid-lookup "Smith, John"`).
- [ ] **Step 3:** Open dashboard, exercise queue (retry, delete, stop, cancel). Open log panel for an entry. Confirm all dashboard fixes from Phase A-D behave correctly.
- [ ] **Step 4:** Commit any cleanups: `chore: post-plan-2 verification sweep`.

---

## Out of scope for Plan 2

These items belong to Plan 1 or Plan 3 — do not attempt here:
- Kernel / daemon / tracker correctness, perf, simplification (Plan 1)
- `src/cli.ts`, `src/utils/*`, `src/scripts/*`, `src/infra/*` changes (Plan 1)
- Workflow `runXxxCli` adapter dedup, `onPreEmitPending` extraction (Plan 3)
- OCR/matching perf hot paths, service-layer fixes (Plan 3)
- Doc layout fixes in root CLAUDE.md (Plan 3)
- Architecture-tree updates in src/core/CLAUDE.md (Plan 3)
