# Parent-Child Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Parent-Child Row to the QueuePanel that summarises an approved OCR prep batch (oath-signature / emergency-contact) and lets the operator drill the QueuePanel into a filtered view of just that batch's children.

**Architecture:** Frontend-only — no backend, no new SSE field. The post-approve prep tracker row (`status=done step=approved`) is no longer filtered out; instead it's rendered by a new `ParentChildRow` component that aggregates its children (entries with `parentRunId === parent.runId`) into a 4-zone bento card. Clicking the card sets app-level state `drilledBatchRunId`, which transforms the QueuePanel into a breadcrumb-headed filtered list. Aggregation logic lives in pure functions for unit-testability.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, lucide-react. Tests via `node:test` + `node:assert/strict`.

---

## File Structure

**New files:**
- `src/dashboard/components/ocr/parent-child-helpers.ts` — `aggregateBatchCounts`, `pickPreviewChildren`, `computeBatchElapsed`, `resolveBatchAccent`. Pure, no React.
- `src/dashboard/components/ocr/ParentChildRow.tsx` — the 4-zone card.
- `tests/unit/dashboard/ocr/types.test.ts` — predicate tests.
- `tests/unit/dashboard/parent-child-helpers.test.ts` — helper tests.

**Modified files:**
- `src/dashboard/components/ocr/types.ts` — add `isApprovedPrepRow`, `isDiscardedPrepRow`.
- `src/dashboard/components/QueuePanel.tsx` — split prep rows, accept drill props, render breadcrumb + filtered list when drilled.
- `src/dashboard/App.tsx` — `drilledBatchRunId` state, wire to QueuePanel.
- `src/dashboard/components/EntryItem.tsx` — drop the "↗ from parent" pill (line 203-210).

---

## Task 1: Add `isApprovedPrepRow` and `isDiscardedPrepRow` predicates

**Files:**
- Modify: `src/dashboard/components/ocr/types.ts`
- Test: `tests/unit/dashboard/ocr/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/dashboard/ocr/types.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isApprovedPrepRow,
  isDiscardedPrepRow,
} from "../../../../src/dashboard/components/ocr/types.js";

describe("isApprovedPrepRow", () => {
  it("returns true for prep rows with status=done step=approved", () => {
    assert.equal(
      isApprovedPrepRow({
        status: "done",
        step: "approved",
        data: { mode: "prepare" },
      }),
      true,
    );
  });

  it("returns false when not a prep row", () => {
    assert.equal(
      isApprovedPrepRow({ status: "done", step: "approved", data: {} }),
      false,
    );
  });

  it("returns false for in-flight prep rows", () => {
    assert.equal(
      isApprovedPrepRow({
        status: "running",
        step: "ocr",
        data: { mode: "prepare" },
      }),
      false,
    );
  });

  it("returns false for failed-discarded prep rows", () => {
    assert.equal(
      isApprovedPrepRow({
        status: "failed",
        step: "discarded",
        data: { mode: "prepare" },
      }),
      false,
    );
  });
});

describe("isDiscardedPrepRow", () => {
  it("returns true for prep rows with status=failed step=discarded", () => {
    assert.equal(
      isDiscardedPrepRow({
        status: "failed",
        step: "discarded",
        data: { mode: "prepare" },
      }),
      true,
    );
  });

  it("returns false when not a prep row", () => {
    assert.equal(
      isDiscardedPrepRow({
        status: "failed",
        step: "discarded",
        data: {},
      }),
      false,
    );
  });

  it("returns false for approved prep rows", () => {
    assert.equal(
      isDiscardedPrepRow({
        status: "done",
        step: "approved",
        data: { mode: "prepare" },
      }),
      false,
    );
  });

  it("returns false for genuinely-failed (non-discarded) prep rows", () => {
    assert.equal(
      isDiscardedPrepRow({
        status: "failed",
        step: "ocr",
        data: { mode: "prepare" },
      }),
      false,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/dashboard/ocr/types.test.ts
```

Expected: FAIL — both predicates are undefined.

- [ ] **Step 3: Implement the predicates**

Edit `src/dashboard/components/ocr/types.ts`. Below the existing `isResolvedPrepRow` (line ~134), add:

```ts
/**
 * A prep row whose operator-resolved state is "approved" — children have been
 * fanned out into the downstream workflow's queue. Drives `ParentChildRow`
 * rendering in the QueuePanel.
 */
export function isApprovedPrepRow(e: {
  status: string;
  step?: string;
  data?: Record<string, string>;
}): boolean {
  if (!isPrepareRow(e)) return false;
  return e.status === "done" && e.step === "approved";
}

/**
 * A prep row the operator discarded. Filtered out of the QueuePanel entirely.
 * Distinct from a genuinely-failed prep row (e.g. OCR error), which stays
 * visible as an `OcrQueueRow` so the operator can retry.
 */
export function isDiscardedPrepRow(e: {
  status: string;
  step?: string;
  data?: Record<string, string>;
}): boolean {
  if (!isPrepareRow(e)) return false;
  return e.status === "failed" && e.step === "discarded";
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/dashboard/ocr/types.test.ts
```

Expected: PASS — 8 tests.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck:all
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/components/ocr/types.ts tests/unit/dashboard/ocr/types.test.ts
git commit -m "feat(dashboard): add isApprovedPrepRow / isDiscardedPrepRow predicates"
```

---

## Task 2: Pure helpers for batch aggregation

**Files:**
- Create: `src/dashboard/components/ocr/parent-child-helpers.ts`
- Test: `tests/unit/dashboard/parent-child-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/dashboard/parent-child-helpers.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateBatchCounts,
  pickPreviewChildren,
  computeBatchElapsed,
  resolveBatchAccent,
} from "../../../src/dashboard/components/ocr/parent-child-helpers.js";
import type { TrackerEntry } from "../../../src/dashboard/components/types.js";

function child(over: Partial<TrackerEntry>): TrackerEntry {
  return {
    workflow: "oath-signature",
    timestamp: "2026-05-01T09:43:00.000Z",
    id: "x",
    runId: "x#1",
    parentRunId: "prep-a3f1",
    status: "pending",
    data: {},
    ...over,
  };
}

describe("aggregateBatchCounts", () => {
  it("counts each status bucket", () => {
    const result = aggregateBatchCounts([
      child({ status: "done" }),
      child({ status: "done" }),
      child({ status: "running" }),
      child({ status: "pending" }),
      child({ status: "pending" }),
      child({ status: "failed" }),
    ]);
    assert.deepEqual(result, {
      done: 2,
      running: 1,
      queued: 2,
      failed: 1,
      total: 6,
    });
  });

  it("treats skipped as done (terminal success)", () => {
    const result = aggregateBatchCounts([
      child({ status: "skipped" }),
      child({ status: "done" }),
    ]);
    assert.equal(result.done, 2);
  });

  it("returns all-zero counts for empty input", () => {
    assert.deepEqual(aggregateBatchCounts([]), {
      done: 0,
      running: 0,
      queued: 0,
      failed: 0,
      total: 0,
    });
  });
});

describe("pickPreviewChildren", () => {
  it("orders running first, then queued, then done, then failed", () => {
    const kids = [
      child({ id: "a", status: "done", data: { name: "A" } }),
      child({ id: "b", status: "failed", data: { name: "B" } }),
      child({ id: "c", status: "running", data: { name: "C" } }),
      child({ id: "d", status: "pending", data: { name: "D" } }),
    ];
    const out = pickPreviewChildren(kids, 4);
    assert.deepEqual(
      out.map((k) => k.id),
      ["c", "d", "a", "b"],
    );
  });

  it("breaks ties on firstLogTs descending", () => {
    const kids = [
      child({ id: "old", status: "running", firstLogTs: "2026-05-01T09:40:00Z" }),
      child({ id: "new", status: "running", firstLogTs: "2026-05-01T09:42:00Z" }),
    ];
    const out = pickPreviewChildren(kids, 2);
    assert.deepEqual(
      out.map((k) => k.id),
      ["new", "old"],
    );
  });

  it("limits to n", () => {
    const kids = Array.from({ length: 10 }, (_, i) =>
      child({ id: `k${i}`, status: "pending" }),
    );
    assert.equal(pickPreviewChildren(kids, 3).length, 3);
  });

  it("returns at most all kids when n > kids.length", () => {
    const kids = [child({ id: "a" }), child({ id: "b" })];
    assert.equal(pickPreviewChildren(kids, 10).length, 2);
  });

  it("resolves name from data.name with fallback to id", () => {
    const out = pickPreviewChildren(
      [
        child({ id: "10794813", data: { name: "Akitsugu Uchida", emplId: "10794813" } }),
        child({ id: "noname", data: {} }),
      ],
      2,
    );
    assert.equal(out[0]?.name, "Akitsugu Uchida");
    assert.equal(out[1]?.name, "noname");
  });

  it("resolves emplId from data.emplId or data.eid", () => {
    const out = pickPreviewChildren(
      [
        child({ id: "a", data: { emplId: "111" } }),
        child({ id: "b", data: { eid: "222" } }),
      ],
      2,
    );
    assert.equal(out[0]?.emplId, "111");
    assert.equal(out[1]?.emplId, "222");
  });
});

describe("computeBatchElapsed", () => {
  it("returns null when no children have firstLogTs", () => {
    assert.equal(computeBatchElapsed([child({})]), null);
  });

  it("uses the earliest firstLogTs as start and latest lastLogTs as end", () => {
    const result = computeBatchElapsed([
      child({
        firstLogTs: "2026-05-01T09:42:00.000Z",
        lastLogTs: "2026-05-01T09:43:00.000Z",
        status: "done",
      }),
      child({
        firstLogTs: "2026-05-01T09:42:30.000Z",
        lastLogTs: "2026-05-01T09:43:38.000Z",
        status: "running",
      }),
    ]);
    assert.equal(result?.startMs, Date.parse("2026-05-01T09:42:00.000Z"));
    assert.equal(result?.endMs, Date.parse("2026-05-01T09:43:38.000Z"));
    assert.equal(result?.frozen, false);
  });

  it("freezes (frozen=true) when every child is terminal", () => {
    const result = computeBatchElapsed([
      child({
        firstLogTs: "2026-05-01T09:42:00.000Z",
        lastLogTs: "2026-05-01T09:43:00.000Z",
        status: "done",
      }),
      child({
        firstLogTs: "2026-05-01T09:42:30.000Z",
        lastLogTs: "2026-05-01T09:44:00.000Z",
        status: "failed",
      }),
    ]);
    assert.equal(result?.frozen, true);
  });

  it("falls back to entry.timestamp when firstLogTs missing", () => {
    const result = computeBatchElapsed([
      child({
        timestamp: "2026-05-01T09:40:00.000Z",
        firstLogTs: undefined,
        lastLogTs: "2026-05-01T09:43:00.000Z",
        status: "done",
      }),
    ]);
    assert.equal(result?.startMs, Date.parse("2026-05-01T09:40:00.000Z"));
  });
});

describe("resolveBatchAccent", () => {
  it("returns destructive when any child failed", () => {
    assert.equal(
      resolveBatchAccent({ done: 1, running: 0, queued: 0, failed: 1, total: 2 }),
      "destructive",
    );
  });

  it("returns success when all children done", () => {
    assert.equal(
      resolveBatchAccent({ done: 5, running: 0, queued: 0, failed: 0, total: 5 }),
      "success",
    );
  });

  it("returns warning while running or queued", () => {
    assert.equal(
      resolveBatchAccent({ done: 1, running: 1, queued: 0, failed: 0, total: 2 }),
      "warning",
    );
    assert.equal(
      resolveBatchAccent({ done: 0, running: 0, queued: 3, failed: 0, total: 3 }),
      "warning",
    );
  });

  it("returns warning for empty batch (zero children)", () => {
    assert.equal(
      resolveBatchAccent({ done: 0, running: 0, queued: 0, failed: 0, total: 0 }),
      "warning",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/dashboard/parent-child-helpers.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `src/dashboard/components/ocr/parent-child-helpers.ts`:

```ts
import type { TrackerEntry } from "../types";

export interface BatchCounts {
  done: number;
  running: number;
  queued: number;
  failed: number;
  total: number;
}

export interface PreviewChild {
  id: string;
  runId?: string;
  name: string;
  emplId?: string;
  status: TrackerEntry["status"];
}

export interface BatchElapsed {
  startMs: number;
  endMs: number;
  /** True when every child is terminal — caller should stop ticking the timer. */
  frozen: boolean;
}

export type BatchAccent = "warning" | "success" | "destructive";

/** Group children by status. `skipped` is folded into `done` (terminal success). */
export function aggregateBatchCounts(children: TrackerEntry[]): BatchCounts {
  const counts: BatchCounts = {
    done: 0,
    running: 0,
    queued: 0,
    failed: 0,
    total: children.length,
  };
  for (const c of children) {
    if (c.status === "done" || c.status === "skipped") counts.done += 1;
    else if (c.status === "running") counts.running += 1;
    else if (c.status === "pending") counts.queued += 1;
    else if (c.status === "failed") counts.failed += 1;
  }
  return counts;
}

const STATUS_ORDER: Record<string, number> = {
  running: 0,
  pending: 1,
  done: 2,
  skipped: 2,
  failed: 3,
};

/** Pick the first n children sorted by (running > queued > done > failed), tiebreak firstLogTs desc. */
export function pickPreviewChildren(
  children: TrackerEntry[],
  n: number,
): PreviewChild[] {
  const sorted = [...children].sort((a, b) => {
    const orderDelta =
      (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
    if (orderDelta !== 0) return orderDelta;
    const aTs = a.firstLogTs ?? a.timestamp ?? "";
    const bTs = b.firstLogTs ?? b.timestamp ?? "";
    if (aTs === bTs) return 0;
    return aTs < bTs ? 1 : -1;
  });
  return sorted.slice(0, n).map((c) => ({
    id: c.id,
    runId: c.runId,
    name: c.data?.name || c.id,
    emplId: c.data?.emplId ?? c.data?.eid,
    status: c.status,
  }));
}

/**
 * Earliest child start ms → latest end ms. Returns null when no child has a
 * usable timestamp. `frozen=true` means every child is terminal — stop the timer.
 */
export function computeBatchElapsed(
  children: TrackerEntry[],
): BatchElapsed | null {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  let any = false;
  let allTerminal = children.length > 0;
  for (const c of children) {
    const startSrc = c.firstLogTs ?? c.timestamp;
    const endSrc = c.lastLogTs ?? c.timestamp;
    if (startSrc) {
      const t = Date.parse(startSrc);
      if (Number.isFinite(t)) {
        startMs = Math.min(startMs, t);
        any = true;
      }
    }
    if (endSrc) {
      const t = Date.parse(endSrc);
      if (Number.isFinite(t)) endMs = Math.max(endMs, t);
    }
    if (
      c.status !== "done" &&
      c.status !== "failed" &&
      c.status !== "skipped"
    ) {
      allTerminal = false;
    }
  }
  if (!any) return null;
  return { startMs, endMs, frozen: allTerminal };
}

/** Color the 3px left accent stripe by overall batch state. */
export function resolveBatchAccent(counts: BatchCounts): BatchAccent {
  if (counts.failed > 0) return "destructive";
  if (counts.total > 0 && counts.running === 0 && counts.queued === 0)
    return "success";
  return "warning";
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/dashboard/parent-child-helpers.test.ts
```

Expected: PASS — 17 tests across 4 describe blocks.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck:all
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/components/ocr/parent-child-helpers.ts tests/unit/dashboard/parent-child-helpers.test.ts
git commit -m "feat(dashboard): add pure helpers for parent-child row aggregation"
```

---

## Task 3: Build the `ParentChildRow` component

**Files:**
- Create: `src/dashboard/components/ocr/ParentChildRow.tsx`

- [ ] **Step 1: Write the component**

Create `src/dashboard/components/ocr/ParentChildRow.tsx`:

```tsx
import { Loader2, Clock, CheckCircle2, AlertTriangle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "../types";
import { useElapsed, formatDuration } from "../hooks/useElapsed";
import { parsePrepareRowData } from "./types";
import {
  aggregateBatchCounts,
  pickPreviewChildren,
  computeBatchElapsed,
  resolveBatchAccent,
  type BatchAccent,
} from "./parent-child-helpers";

const PREVIEW_KIDS = 3;

const ACCENT_BORDER: Record<BatchAccent, string> = {
  warning: "border-l-warning",
  success: "border-l-success",
  destructive: "border-l-destructive",
};

const STATUS_ICON: Record<string, { Icon: LucideIcon; color: string; spin: boolean }> = {
  running: { Icon: Loader2, color: "text-primary", spin: true },
  pending: { Icon: Clock, color: "text-warning", spin: false },
  done: { Icon: CheckCircle2, color: "text-success", spin: false },
  skipped: { Icon: CheckCircle2, color: "text-success", spin: false },
  failed: { Icon: AlertTriangle, color: "text-destructive", spin: false },
};

export interface ParentChildRowProps {
  /** The approved prep tracker row. */
  parent: TrackerEntry;
  /** All children of this parent (entries with parentRunId === parent.runId).
   *  Named `childEntries` (not `children`) to avoid colliding with React's
   *  built-in `children` prop and with the `children` keyword. */
  childEntries: TrackerEntry[];
  isDrilled: boolean;
  onDrillIn: (parentRunId: string) => void;
}

export function ParentChildRow({
  parent,
  childEntries,
  isDrilled,
  onDrillIn,
}: ParentChildRowProps) {
  const data = parsePrepareRowData(parent.data);
  const counts = aggregateBatchCounts(childEntries);
  const accent = resolveBatchAccent(counts);
  const previewKids = pickPreviewChildren(childEntries, PREVIEW_KIDS);
  const elapsed = computeBatchElapsed(childEntries);

  const liveTick = useElapsed(
    elapsed && !elapsed.frozen ? new Date(elapsed.startMs).toISOString() : null,
  );
  const elapsedLabel = elapsed
    ? elapsed.frozen
      ? formatDuration(
          new Date(elapsed.startMs).toISOString(),
          new Date(elapsed.endMs).toISOString(),
        )
      : liveTick
    : "";

  const runId = parent.runId ?? parent.id;
  const filename = data?.pdfOriginalName || "Prep batch";
  const prepTime = formatTime(parent.timestamp);

  const segs = computeProgressSegments(counts);

  return (
    <div className="px-3 pt-2 first:pt-3">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={isDrilled}
        aria-label={`${filename} — ${counts.done} of ${counts.total} done`}
        onClick={() => onDrillIn(runId)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onDrillIn(runId);
          }
        }}
        className={cn(
          "group bg-card border border-border border-l-[3px] rounded-lg cursor-pointer outline-none overflow-hidden",
          "transition-all duration-200",
          "hover:border-primary/40 hover:shadow-lg hover:shadow-black/20",
          "focus-visible:ring-2 focus-visible:ring-primary",
          ACCENT_BORDER[accent],
          isDrilled && "ring-2 ring-primary",
        )}
      >
        {/* Header */}
        <div className="px-3.5 py-2.5 flex items-center justify-between gap-2 min-w-0">
          <span className="font-semibold text-[14px] text-foreground truncate min-w-0 flex-1">
            {filename}
          </span>
          <span
            className={cn(
              "text-[10px] font-medium px-2 py-0.5 rounded-md font-sans tracking-wide flex-shrink-0",
              "bg-warning/12 text-warning border border-warning/40",
            )}
          >
            {counts.done} / {counts.total}
          </span>
        </div>

        <div className="border-t border-border/60" />

        {/* Progress zone */}
        <div className="px-3.5 pt-2 pb-2.5 bg-secondary/20">
          <div className="flex items-center gap-3 font-mono text-[10.5px] mb-1.5">
            <span className="text-success">● {counts.done} done</span>
            <span className="text-primary">● {counts.running} running</span>
            <span className="text-warning">● {counts.queued} queued</span>
            {counts.failed > 0 && (
              <span className="text-destructive">● {counts.failed} failed</span>
            )}
          </div>
          <div className="flex gap-[2px]">
            {segs.map((s, i) => (
              <div
                key={i}
                className={cn("h-[5px] rounded-[2px]", s.cls)}
                style={{ flex: s.flex }}
              />
            ))}
          </div>
        </div>

        <div className="border-t border-border/60" />

        {/* Children preview */}
        {previewKids.length > 0 && (
          <>
            <div className="px-3.5 py-2 bg-card flex flex-col gap-1.5 font-mono text-[10.5px]">
              {previewKids.map((k) => {
                const cfg = STATUS_ICON[k.status] ?? STATUS_ICON.pending;
                const Icon = cfg.Icon;
                return (
                  <div key={k.id} className="flex items-center gap-2 min-w-0">
                    <Icon
                      className={cn(
                        "w-3 h-3 flex-shrink-0",
                        cfg.color,
                        cfg.spin && "animate-spin motion-reduce:animate-none",
                      )}
                      aria-hidden
                    />
                    <span className="text-foreground/90 truncate flex-1 min-w-0">
                      {k.name}
                    </span>
                    {k.emplId && (
                      <span className="text-muted-foreground text-[9.5px] flex-shrink-0 tabular-nums">
                        {k.emplId}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="border-t border-border/60" />
          </>
        )}

        {/* Footer */}
        <div className="px-3.5 py-1.5 bg-secondary/20 flex items-center gap-2 text-[11px] font-mono text-muted-foreground min-w-0">
          <span className="tabular-nums flex-shrink-0">{prepTime}</span>
          <span className="bg-secondary/80 px-1.5 py-px rounded font-medium flex-shrink-0">
            prep#{runId.slice(-4)}
          </span>
          <span className="flex-1" />
          {elapsedLabel && (
            <span
              className={cn(
                "tabular-nums flex-shrink-0",
                elapsed?.frozen ? "" : "text-primary",
              )}
            >
              {elapsedLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function computeProgressSegments(counts: ReturnType<typeof aggregateBatchCounts>) {
  const segs: { cls: string; flex: number }[] = [];
  if (counts.done > 0) segs.push({ cls: "bg-success", flex: counts.done });
  if (counts.running > 0) segs.push({ cls: "bg-primary", flex: counts.running });
  if (counts.queued > 0) segs.push({ cls: "bg-warning", flex: counts.queued });
  if (counts.failed > 0) segs.push({ cls: "bg-destructive", flex: counts.failed });
  if (segs.length === 0) segs.push({ cls: "bg-secondary", flex: 1 });
  return segs;
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return ts.slice(11, 16);
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck:all
```

Expected: clean. (No tests for this file — pure-React, no jsdom in the project.)

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/ocr/ParentChildRow.tsx
git commit -m "feat(dashboard): add ParentChildRow component"
```

---

## Task 4: Wire `QueuePanel` to render approved prep rows as `ParentChildRow`

**Files:**
- Modify: `src/dashboard/components/QueuePanel.tsx`

This task only handles rendering the post-approve summary card in the main view. Drill-in (breadcrumb + filtered list) is Task 5.

- [ ] **Step 1: Update imports + filter**

Edit `src/dashboard/components/QueuePanel.tsx`:

Replace this import block (lines 6-8):

```ts
import { OcrQueueRow } from "./ocr/OcrQueueRow";
import type { TrackerEntry } from "./types";
import { isPrepareRow, isResolvedPrepRow } from "./ocr/types";
```

with:

```ts
import { OcrQueueRow } from "./ocr/OcrQueueRow";
import { ParentChildRow } from "./ocr/ParentChildRow";
import type { TrackerEntry } from "./types";
import {
  isPrepareRow,
  isApprovedPrepRow,
  isDiscardedPrepRow,
} from "./ocr/types";
```

Replace the `visibleEntries` useMemo (lines 68-71):

```tsx
const visibleEntries = useMemo(
  () => entries.filter((e) => !isResolvedPrepRow(e)),
  [entries],
);
```

with:

```tsx
const visibleEntries = useMemo(
  () => entries.filter((e) => !isDiscardedPrepRow(e)),
  [entries],
);
```

- [ ] **Step 2: Split prep rows into in-flight vs approved**

Replace the `previewEntries` useMemo (lines 77-80):

```tsx
const previewEntries = useMemo(
  () => visibleEntries.filter(isPrepareRow),
  [visibleEntries],
);
```

with:

```tsx
const inFlightPrepEntries = useMemo(
  () =>
    visibleEntries.filter(
      (e) => isPrepareRow(e) && !isApprovedPrepRow(e),
    ),
  [visibleEntries],
);

const approvedPrepEntries = useMemo(
  () => visibleEntries.filter(isApprovedPrepRow),
  [visibleEntries],
);

/**
 * Map approved-prep runId → list of child entries (entries whose
 * `parentRunId` matches the prep row's runId). Computed once per entries
 * change so each ParentChildRow render is O(1) lookup.
 */
const childrenByParentRun = useMemo(() => {
  const map = new Map<string, TrackerEntry[]>();
  for (const e of visibleEntries) {
    if (!e.parentRunId) continue;
    const list = map.get(e.parentRunId) ?? [];
    list.push(e);
    map.set(e.parentRunId, list);
  }
  return map;
}, [visibleEntries]);
```

- [ ] **Step 3: Update the regular-list filter so children of approved prep rows are excluded from the flat list**

Replace the `filtered` useMemo (lines 82-92):

```tsx
const filtered = useMemo(() => {
  // Exclude prep rows from the regular list — they render via PreviewRow above.
  let result = visibleEntries.filter((e) => !isPrepareRow(e));
  if (statusFilter) {
    result = result.filter((e) =>
      statusFilter === "pending" ? e.status === "pending" || e.status === "skipped" : e.status === statusFilter,
    );
  }
  return result;
}, [visibleEntries, statusFilter]);
```

with:

```tsx
/**
 * Set of parent runIds that are currently rendered as ParentChildRow above
 * the regular list. Children of these parents are folded INTO the parent
 * card, so they should not also appear in the flat list.
 */
const approvedParentRunIds = useMemo(
  () =>
    new Set(
      approvedPrepEntries
        .map((e) => e.runId ?? e.id),
    ),
  [approvedPrepEntries],
);

const filtered = useMemo(() => {
  let result = visibleEntries.filter(
    (e) =>
      !isPrepareRow(e) &&
      !(e.parentRunId && approvedParentRunIds.has(e.parentRunId)),
  );
  if (statusFilter) {
    result = result.filter((e) =>
      statusFilter === "pending"
        ? e.status === "pending" || e.status === "skipped"
        : e.status === statusFilter,
    );
  }
  return result;
}, [visibleEntries, statusFilter, approvedParentRunIds]);
```

- [ ] **Step 4: Render approved prep rows above the in-flight ones**

Find the JSX block that maps `previewEntries.map(...)` (lines 106-117) and replace it with:

```tsx
{/* Pinned: approved prep rows render as ParentChildRow batch summaries. */}
{approvedPrepEntries.map((e) => {
  const runId = e.runId ?? e.id;
  return (
    <ParentChildRow
      key={`pcr-${runId}`}
      parent={e}
      children={childrenByParentRun.get(runId) ?? []}
      isDrilled={false}
      onDrillIn={() => {
        /* Task 5 wires this. */
      }}
    />
  );
})}

{/* Pinned: in-flight prep rows (preparing/ready/reviewing/failed-non-discarded). */}
{inFlightPrepEntries.map((e) => {
  const runId = e.runId ?? e.id;
  return (
    <OcrQueueRow
      key={`prep-${runId}`}
      entry={e}
      isReviewing={reviewingPrepId === runId}
      onOpenReview={(rid) => onOpenReview?.(rid)}
      onReupload={onReupload}
    />
  );
})}
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck:all
```

Expected: clean.

- [ ] **Step 6: Run unit tests**

```bash
npm test
```

Expected: all existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/components/QueuePanel.tsx
git commit -m "feat(dashboard): render approved prep rows as ParentChildRow in QueuePanel"
```

---

## Task 5: QueuePanel drill-in (breadcrumb + filtered list + batch actions)

**Files:**
- Modify: `src/dashboard/components/QueuePanel.tsx`

- [ ] **Step 1: Add drill props to `QueuePanelProps`**

Edit the `QueuePanelProps` interface (around line 10). Add these three fields after `onReupload`:

```tsx
  /** RunId of the approved prep row currently drilled-into. null = main queue view. */
  drilledBatchRunId?: string | null;
  /** Open the drilled batch view for the given parent runId. */
  onDrillIn?: (parentRunId: string) => void;
  /** Exit drilled batch view back to the main queue. */
  onDrillOut?: () => void;
```

- [ ] **Step 2: Accept the new props in the function signature**

Edit the function signature (around line 51):

```tsx
export function QueuePanel({
  entries,
  workflow,
  selectedId,
  onSelect,
  reviewingPrepId,
  onOpenReview,
  onReupload,
  drilledBatchRunId,
  onDrillIn,
  onDrillOut,
  loading,
  runControlsSlot,
}: QueuePanelProps) {
```

- [ ] **Step 3: Add drill mode resolver + drilled-children memo**

Below the `approvedPrepEntries` useMemo (added in Task 4), add:

```tsx
const drilledParent = useMemo(
  () =>
    drilledBatchRunId
      ? approvedPrepEntries.find(
          (e) => (e.runId ?? e.id) === drilledBatchRunId,
        ) ?? null
      : null,
  [drilledBatchRunId, approvedPrepEntries],
);

const drilledChildren = useMemo(
  () =>
    drilledBatchRunId ? childrenByParentRun.get(drilledBatchRunId) ?? [] : [],
  [drilledBatchRunId, childrenByParentRun],
);
```

- [ ] **Step 4: Wire onDrillIn into the ParentChildRow callback**

In the `approvedPrepEntries.map` block from Task 4, replace `onDrillIn={() => { /* Task 5 wires this. */ }}` with:

```tsx
onDrillIn={(rid) => onDrillIn?.(rid)}
```

- [ ] **Step 5: Render the drilled view conditionally**

Wrap the existing JSX inside the QueuePanel return so it switches on `drilledParent`. Replace the entire return block (lines 94-163) with:

```tsx
return (
  <div className="w-[300px] min-[1440px]:w-[380px] 2xl:w-[460px] flex-shrink-0 flex flex-col bg-background">
    {drilledParent ? (
      <DrilledHeader parent={drilledParent} onBack={() => onDrillOut?.()} />
    ) : (
      <div className="h-[69.5px] flex items-center px-3 min-[1440px]:px-4 py-2 border-b border-border bg-card/60 flex-shrink-0">
        <StatPills
          entries={visibleEntries}
          activeFilter={statusFilter}
          onFilter={setStatusFilter}
        />
      </div>
    )}

    <div className="flex-1 overflow-y-auto border-b border-border">
      {drilledParent ? (
        drilledChildren.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No children yet"
            description="Children will appear here as the workflow processes them"
          />
        ) : (
          drilledChildren.map((entry) => (
            <EntryItem
              key={entry.id}
              entry={entry}
              selected={selectedId === entry.id}
              onClick={() => onSelect(entry.id)}
            />
          ))
        )
      ) : (
        <>
          {approvedPrepEntries.map((e) => {
            const runId = e.runId ?? e.id;
            return (
              <ParentChildRow
                key={`pcr-${runId}`}
                parent={e}
                childEntries={childrenByParentRun.get(runId) ?? []}
                isDrilled={false}
                onDrillIn={(rid) => onDrillIn?.(rid)}
              />
            );
          })}
          {inFlightPrepEntries.map((e) => {
            const runId = e.runId ?? e.id;
            return (
              <OcrQueueRow
                key={`prep-${runId}`}
                entry={e}
                isReviewing={reviewingPrepId === runId}
                onOpenReview={(rid) => onOpenReview?.(rid)}
                onReupload={onReupload}
              />
            );
          })}
          {loading ? (
            <div className="space-y-0">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="px-5 py-3.5 border-b border-border">
                  <div className="flex justify-between mb-2">
                    <div className="h-4 w-32 rounded bg-muted animate-pulse" />
                    <div className="h-4 w-16 rounded bg-muted animate-pulse" />
                  </div>
                  <div className="h-3 w-48 rounded bg-muted animate-pulse mt-1" />
                  <div className="h-3 w-24 rounded bg-muted animate-pulse mt-2" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No entries yet"
              description="Data will appear here as workflows run"
            />
          ) : (
            filtered.map((entry) => (
              <EntryItem
                key={entry.id}
                entry={entry}
                selected={selectedId === entry.id}
                onClick={() => onSelect(entry.id)}
              />
            ))
          )}
        </>
      )}
    </div>

    {runControlsSlot && (
      <div className="h-12 flex items-center gap-2 px-3 min-[1440px]:px-4 bg-card/40 flex-shrink-0 justify-end">
        {runControlsSlot}
      </div>
    )}
  </div>
);
```

- [ ] **Step 6: Add the `DrilledHeader` sub-component**

At the bottom of `QueuePanel.tsx`, after the `QueuePanel` function, add:

```tsx
function DrilledHeader({
  parent,
  onBack,
}: {
  parent: TrackerEntry;
  onBack: () => void;
}) {
  const data = parsePrepareRowData(parent.data);
  const filename = data?.pdfOriginalName || "Prep batch";
  const runId = parent.runId ?? parent.id;
  const time = new Date(parent.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className="h-[69.5px] flex flex-col justify-center px-3 min-[1440px]:px-4 border-b border-border bg-card/60 flex-shrink-0 gap-1">
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-1 text-[11px] text-foreground hover:bg-secondary/70 flex-shrink-0"
        >
          ← Queue
        </button>
        <span className="text-muted-foreground/60">/</span>
        <span className="font-semibold text-[13px] text-foreground truncate min-w-0 flex-1">
          {filename}
        </span>
      </div>
      <div className="text-[10px] font-mono text-muted-foreground pl-1">
        Approved {time} · prep#{runId.slice(-4)}
      </div>
    </div>
  );
}
```

Add this import at the top of the file (with the other ocr imports):

```tsx
import { parsePrepareRowData } from "./ocr/types";
```

- [ ] **Step 7: Run typecheck**

```bash
npm run typecheck:all
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/components/QueuePanel.tsx
git commit -m "feat(dashboard): drill QueuePanel into batch view of children"
```

---

## Task 6: Wire `App.tsx` `drilledBatchRunId` state

**Files:**
- Modify: `src/dashboard/App.tsx`

- [ ] **Step 1: Add the state**

After the `reviewingPrepId` state (around line 51), add:

```tsx
const [drilledBatchRunId, setDrilledBatchRunId] = useState<string | null>(null);
```

- [ ] **Step 2: Wire callbacks into QueuePanel**

In the `<QueuePanel ... />` invocation (around line 228), add three new props before `loading`:

```tsx
drilledBatchRunId={drilledBatchRunId}
onDrillIn={(parentRunId) => {
  // Drilling exits any open prep review and clears any selected child —
  // the user explicitly switched contexts.
  setReviewingPrepId(null);
  setSelectedId(null);
  setDrilledBatchRunId(parentRunId);
}}
onDrillOut={() => {
  setDrilledBatchRunId(null);
}}
```

- [ ] **Step 3: Clear drill state when workflow changes**

In `handleWorkflowChange` (line 152), update to also clear drill:

```tsx
const handleWorkflowChange = useCallback((wf: string) => {
  setWorkflow(wf);
  setSelectedId(null);
  setDrilledBatchRunId(null);
}, []);
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck:all
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/App.tsx
git commit -m "feat(dashboard): wire drilledBatchRunId state in App"
```

---

## Task 7: Drop the "↗ from parent" pill from `EntryItem`

**Files:**
- Modify: `src/dashboard/components/EntryItem.tsx`

The pill is now redundant — context lives in the Parent-Child Row above (main view) or the breadcrumb header (drilled view).

- [ ] **Step 1: Remove the pill**

In `src/dashboard/components/EntryItem.tsx`, delete lines 203-210:

```tsx
{entry.parentRunId && (
  <span
    className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground flex-shrink-0"
    title={`Delegated from parent run ${entry.parentRunId}`}
  >
    ↗ from parent
  </span>
)}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck:all
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/EntryItem.tsx
git commit -m "refactor(dashboard): drop ↗ from parent pill from EntryItem"
```

---

## Task 8: Manual verification

No code changes — this task only validates the feature end-to-end.

- [ ] **Step 1: Boot the dashboard**

```bash
npm run dashboard
```

Open http://localhost:5173.

- [ ] **Step 2: Drive an oath-signature OCR batch**

In a separate terminal, upload a multi-row PDF via the existing OCR flow (RunModal → workflow=ocr → upload PDF). Approve the prep review. Confirm:

- The OcrQueueRow disappears.
- A `ParentChildRow` appears at the top of the QueuePanel for `oath-signature`.
- The progress strip + colored caption reflect actual children ("● 0 done · 1 running · 4 queued" or similar).
- Up to 3 child names show in the preview strip with status icons.
- The footer reads `9:NN · prep#XXXX ... 0:NN` with the timer ticking.
- The accent stripe is amber while children are queued/running.
- The right-most column shows the elapsed time, blue while running.

- [ ] **Step 3: Drill in and back**

Click the Parent-Child Row. Confirm:

- StatPills swap to the breadcrumb (`← Queue / oath-batch-2025.pdf`).
- The list shows only this batch's children (no unrelated rows).
- Clicking a child opens its log stream in the LogPanel.
- Clicking `← Queue` returns to the main view; the Parent-Child Row is still pinned at the top.

- [ ] **Step 4: Terminal-state behaviour**

Wait for all children to finish. Confirm:

- Counts show "● N done · 0 running · 0 queued".
- The accent stripe turns green.
- The elapsed timer freezes at the final duration (e.g. `2m 14s`, no longer ticking, no longer blue).
- Force a child to fail (manually mutate its tracker JSONL or run a known-bad emplId): the accent flips red and "● 1 failed" appears in the caption.

- [ ] **Step 5: Discarded prep row stays hidden**

Upload another PDF and discard it. Confirm:

- No Parent-Child Row appears.
- No OcrQueueRow remains.
- The discarded entry is invisible in the QueuePanel.

- [ ] **Step 6: Workflow switch clears drill**

While drilled into a batch in `oath-signature`, switch to `onboarding` via the WorkflowRail. Confirm:

- The QueuePanel returns to the main view (StatPills visible).
- Switching back to `oath-signature` shows the main view, not the previously-drilled state.

- [ ] **Step 7: Final cleanup commit (only if anything was tweaked during verification)**

If verification turned up tweaks, commit them with a `fix(dashboard):` message. Otherwise this task closes without a commit.
