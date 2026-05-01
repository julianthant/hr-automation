# Parent-Child Row Design

**Date:** 2026-05-01
**Scope:** `oath-signature`, `emergency-contact`, and any future workflow that fans out from an OCR prep row.

## Goal

When the operator approves an OCR prep row, it spawns N child queue items in the downstream workflow (oath-signature or emergency-contact). Today the prep row is filtered out after approval (`isResolvedPrepRow`) and the children scatter through the regular queue with only a tiny `↗ from parent` pill. The operator loses both the batch-level summary and the link back to "this PDF turned into these N people."

The **Parent-Child Row** keeps the prep row visible after approval as an aggregate batch summary, and lets the operator click it to drill the QueuePanel into a filtered batch view that shows only those children.

## Visual structure

Four zones, stacked vertically inside one card. Same bento language as `EntryItem`. Width: 380 px (the post-`min-[1440px]` QueuePanel).

```
┌──────────────────────────────────────────┐
│ oath-batch-2025.pdf            [3 / 10]  │  ← header — filename + ratio badge
├──────────────────────────────────────────┤
│ ● 2 done   ● 1 running   ● 7 queued     │
│ ▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │  ← progress zone — caption + bar
├──────────────────────────────────────────┤
│ ⟳  Akitsugu Uchida          10794813    │
│ ⏱  Maria Hernandez          10859569    │  ← child preview — first 3 names
│ ⏱  Jordan Lee               10912001    │
├──────────────────────────────────────────┤
│ 9:42 · prep#a3f1                  1m 38s│  ← footer — time · prep id · elapsed
└──────────────────────────────────────────┘
```

- **No icon** before the filename.
- **No "+ N more — drill in to see all"** row under the kid preview.
- **No explicit "Drill in →" CTA** — the whole card is the drill affordance, hover lifts the border.
- **Footer's right slot is the batch's elapsed time**, computed from the earliest child `firstLogTs` to either the latest child `lastLogTs` (still running) or the latest child terminal ts (all done).

3 px left accent stripe, color-keyed to overall batch state:
- amber (`--warning`) — any queued or running children remain
- green (`--success`) — all children done
- red (`--destructive`) — any failed children (overrides green/amber)

## Data model

The Parent-Child Row reads from existing tracker fields — no new emit, no new endpoint.

- **Parent identity:** the approved prep tracker row (`data.mode === "prepare"`, `status === "done"`, `step === "approved"`). Its `runId` is the batch key.
- **Children:** `entries.filter(e => e.parentRunId === parentRow.runId)`. `parentRunId` already exists on `TrackerEntry` (added 2026-05-01) and is stamped on every child by the OCR approval fan-out (`enqueueFromHttp` in `src/tracker/ocr-http.ts`).
- **Counts** computed frontend-side by reducing children by status. Order of precedence for the ratio badge: `failed > running > done > queued`.
- **Filename:** `parsePrepareRowData(parentRow.data).pdfOriginalName`.
- **prep id:** last 4 chars of parentRow.runId, prefixed `prep#` — same shape as today's OcrQueueRow.
- **Elapsed:** `min(child.firstLogTs)` → `max(child.lastLogTs)` for in-flight; freezes at `max(child terminal ts)` once all children terminate.
- **Child preview (first 3):** sort children by `(running first, queued, done, failed)` then by `firstLogTs` desc, take 3. EID resolved via `data.emplId ?? data.eid`.

## Lifecycle

| State | Render |
|---|---|
| Prep row in-flight (preparing / ready / reviewing / failed-but-not-discarded) | Today's `OcrQueueRow` (unchanged) |
| Prep row `done step=approved` | **Parent-Child Row** (new) |
| Prep row `failed step=discarded` | Hidden (today's filter, unchanged) |

The Parent-Child Row stays visible for as long as the date page shows it (today's `useEntries` scope). Once the date rolls over, the row falls out with the rest of the day's data — no auto-retire.

## Drilled-in QueuePanel state

When the operator clicks a Parent-Child Row:

- App-level state `drilledBatchRunId` is set to the parent's runId.
- QueuePanel header swaps from `StatPills` to a breadcrumb row:
  ```
  [← Queue]  /  oath-batch-2025.pdf            2/10 ✓
  ```
  with a sub-line `Approved 9:42 · prep#a3f1 · Open prep review` (the `Open prep review` link reopens `OcrReviewPane` for audit).
- The entry list filters to `entries.filter(e => e.parentRunId === drilledBatchRunId)`, rendered with the regular `EntryItem` shell — no special child styling, since context is set by the breadcrumb.
- The QueuePanel footer swaps to batch-level actions: `↻ Retry batch` (re-enqueues failed children), `▶` (manual run controls preserved). Pause is out of scope for v1.
- The LogPanel and SessionPanel are untouched. Selecting a child still opens its log stream as today.
- `[← Queue]` clears `drilledBatchRunId`, returning to the main view.

The drilled state is **not** persisted in the URL for v1 — operator drills are transient. (URL persistence is a 1-line addition if that turns out to bite.)

## File touch list

Frontend only. Backend changes are zero — `parentRunId` already exists.

**New:**
- `src/dashboard/components/ocr/ParentChildRow.tsx` — the four-zone card.
- `src/dashboard/components/ocr/parent-child-helpers.ts` — pure functions: `aggregateBatchCounts(children)`, `pickPreviewChildren(children, n)`, `computeBatchElapsed(children)`, `resolveBatchAccent(counts)`.

**Edited:**
- `src/dashboard/App.tsx` — add `drilledBatchRunId` state, wire props through to `QueuePanel`.
- `src/dashboard/components/QueuePanel.tsx`:
  - Replace today's `!isResolvedPrepRow(e)` filter with `!isDiscardedPrepRow(e)` so approved prep rows stay visible.
  - Split prep rows into `inFlightPrepEntries` (today's `OcrQueueRow`) and `approvedPrepEntries` (new `ParentChildRow`).
  - When `drilledBatchRunId` is set, swap StatPills for breadcrumb header, filter list to children of that runId, swap footer to batch-level actions.
- `src/dashboard/components/ocr/types.ts` — keep `isResolvedPrepRow` for the `failedIds` derivation in `App.tsx` (still needs to exclude both approved and discarded prep rows from retry-bulk targets). Add two sibling predicates: `isApprovedPrepRow` (drives the `ParentChildRow` split) and `isDiscardedPrepRow` (drives the QueuePanel visibility filter).
- `src/dashboard/components/EntryItem.tsx` — drop the `↗ from parent` pill (line 203-210). Inside the drilled view, the breadcrumb already provides the parent context; in the main view, parent context is owned by the Parent-Child Row above.

## Testing

- Unit tests for the four helpers in `parent-child-helpers.ts` (pure functions, no DOM).
- Manual: run `npm run dashboard`, complete an oath-signature OCR approve flow with 3+ children, verify (a) Parent-Child Row appears, (b) drill-in filters list, (c) breadcrumb back returns, (d) all-done state turns the accent stripe green and freezes the elapsed timer.

## Out of scope

- Retry-batch / pause-batch implementation depth — covered by the existing `RetryAllButton` plumbing scoped to the drilled `failedIds`.
- Cross-day batch grouping (children that landed on a different date than the parent).
- Batch-level keyboard shortcuts.
- URL persistence for `drilledBatchRunId`.
