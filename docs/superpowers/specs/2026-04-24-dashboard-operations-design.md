# Dashboard Operations — Design

**Date:** 2026-04-24
**Status:** Draft, awaiting user review
**Scope:** Add retry, edit-and-resume, daemon ops, and queue management to the dashboard. All features built on workflow-agnostic primitives so future workflows pick them up for free.

## Goals

The dashboard is read-only today. Every recovery action — retrying a failure, hand-correcting bad extraction data, spawning more daemons, cancelling a queued item — happens at the CLI. This spec adds those actions inline, without per-workflow code in the dashboard.

Three capabilities:

1. **Retry** failed runs — single, bulk, or all-failed-on-step.
2. **Edit & Resume** — open a panel showing the entry's stored data, edit fields, run with those values prefilled (skipping extraction).
3. **Daemon ops** — list / spawn / stop / log-tail daemons inline; cancel and reorder queued items.

All three are wired into existing surfaces (`EntryItem`, `LogPanel`, `SessionPanel`, `QueuePanel`, `TopBar`). No new top-level pages.

## Non-goals

- Schedule a run for later (deferred — no use case yet).
- Pause-claim toggle on daemons (deferred — `End` already covers the urgent case).
- Reorder by drag-drop (start with a `▲ Bump` button; drag-drop is polish).
- Frontend test harness (project has none — established 2026-04-19 lessons learned; manual verification stays the rule).
- Dashboard-side authorization / multi-user (single-user tool).

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Dashboard SPA                           │
│ ┌────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│ │ TopBar │  │QueuePanel│  │ LogPanel │  │   SessionPanel     │  │
│ │+depth  │  │+bulk-bar │  │+EditTab  │  │+daemon rows+spawn  │  │
│ └────────┘  └──────────┘  └──────────┘  └────────────────────┘  │
│       │           │             │                │              │
│       │  POST /api/retry, /retry-bulk, /run-with-data           │
│       │  POST /api/cancel-queued, /api/queue/bump               │
│       │  GET  /api/daemons | POST /api/daemons/{spawn,stop}     │
│       │  GET  /events/daemon-log SSE                            │
│       ▼                                                          │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                    SSE server (dashboard.ts)                     │
│ ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│ │ retry endpoints │  │ queue mutations  │  │ daemon endpoints │ │
│ │ → enqueue-      │  │ → daemon-queue   │  │ → daemon-        │ │
│ │   dispatch      │  │   (locked write) │  │   registry/      │ │
│ │                 │  │                  │  │   client         │ │
│ └─────────────────┘  └──────────────────┘  └──────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                          Kernel (core/)                          │
│ - Persists `entry.input` on the pending tracker row              │
│ - Merges `input.prefilledData` into ctx.data before handler runs │
│ - Honors `editable?: boolean` on `WorkflowMetadata.detailFields` │
└──────────────────────────────────────────────────────────────────┘
```

The kernel changes are the load-bearing scalability decision. Once `entry.input` is persisted and `prefilledData` merging is generic, the dashboard backend has zero per-workflow logic.

## Section 1 — Kernel changes (foundations)

### 1.1 Persist `entry.input` on pending rows

**Where:** `src/core/enqueue-dispatch.ts` (`onPreEmitPending` callback, line ~128) and any other pending emitter (audit `serializeInputForTracker` callers).

**Change:** the pending tracker row gets a new field alongside `data`:

```ts
// src/tracker/jsonl.ts TrackerEntry
interface TrackerEntry {
  // ... existing fields ...
  input?: Record<string, unknown>;  // original validated input, set on pending only
}
```

`onPreEmitPending` writes `input: <validated input object>` in addition to `data: serializeInputForTracker(item)`. Subsequent status updates (`running`, `done`, `failed`) do not touch `input` — the dashboard always finds the original input by walking back to the row's pending entry.

**Why a separate field, not reuse `data`:** `data` is mutated by `ctx.updateData(...)` during the handler. Conflating "what the handler stored" with "what the workflow was invoked with" is the bug the step-cache learned the hard way. Two fields, two purposes.

**Size guard:** input objects for HR workflows are < 4KB in practice. The pending row is one JSONL line; if a future workflow has a huge input (e.g. embedded PDFs), document a `serializeInput` override on `WorkflowConfig`. Out of scope for this pass.

### 1.2 Generic `prefilledData` channel

**Where:** `src/core/workflow.ts` (`runOneItem` or `runWorkflow` — wherever `Ctx` is constructed).

**Change:** before the handler runs, if the parsed input has a `prefilledData` field (any shape), call `ctx.updateData(input.prefilledData)`. This pre-populates `ctx.data` so handlers that gate on data presence (e.g. `if (!ctx.data.fullName) await ctx.step("extraction", ...)`) skip extraction automatically.

**Schema:** `prefilledData` is added to a generic kernel-level wrapper, not each workflow's schema. Workflows that opt in already have their data shapes; the channel just merges arbitrary keys. The Zod schema on the workflow's input does not need to declare `prefilledData` because the kernel strips it before validation, applies it after.

Sketch (no input mutation — destructure to keep the original object intact for callers):

```ts
// src/core/workflow.ts
function splitPrefilled(input: unknown): {
  cleaned: unknown;
  prefilled: Record<string, unknown> | null;
} {
  if (!input || typeof input !== "object") return { cleaned: input, prefilled: null };
  const { prefilledData, ...rest } = input as Record<string, unknown>;
  const prefilled =
    prefilledData && typeof prefilledData === "object"
      ? (prefilledData as Record<string, unknown>)
      : null;
  return { cleaned: rest, prefilled };
}

// runOneItem (existing):
const { cleaned, prefilled } = splitPrefilled(item);
const validated = wf.config.schema.parse(cleaned);
// ... build ctx ...
if (prefilled) ctx.updateData(prefilled);
await wf.config.handler(ctx, validated);
```

**Why kernel-level, not per-workflow:** edit-and-resume should work for *every* workflow with no per-workflow scaffolding. Adding the field once to the kernel costs ~20 lines; adding it to six workflow schemas costs six edits and grows linearly with new workflows.

### 1.3 `ctx.skipStep(name)` for true "skipped" semantics

Today `ctx.markStep(name)` emits a `running` row, which the StepPipeline renders as completed-instantly. For edit-and-resume, the bypassed extraction step should render as `skipped` (the `TrackerEntry.status` enum already has this value — `"pending" | "running" | "done" | "failed" | "skipped"`).

**Where:** `src/core/stepper.ts` (`Stepper` class).

**Change:** add a `skipStep(name)` method that emits a `running` row immediately followed by a `skipped` terminal row for that step name. Same plumbing as `step(name, fn)` minus the `fn` invocation. Updates `currentStep` like `markStep` does.

```ts
skipStep(name: TStep): void {
  this.emitStep(name);             // running
  this.emitSkipped(name);          // terminal
  this.currentStep = name;
}
```

`emitSkipped` is a new callback in the stepper-emit interface; `withTrackedWorkflow` writes a row with `status: "skipped"` matching the existing pattern for the other status emits.

The dashboard's `StepPipeline` already understands `skipped` (or trivially can — visual treatment can be a muted dot, distinct from `done`'s green and `failed`'s red). The visual design pass will lock the appearance.

### 1.4 `editable?: boolean` on `DetailField`

**Where:** `src/core/types.ts` `DetailField` interface.

**Change:**

```ts
interface DetailField {
  key: string;
  label: string;
  editable?: boolean;  // new — defaults to false
}
```

Workflows declaring detailFields opt into editability per-field. The Edit Data form on the dashboard renders only fields where `editable: true`. Unmarked fields stay display-only.

This is the single source of truth for what's editable. No parallel registry, no inferred-from-schema shenanigans.

## Section 2 — Backend endpoints

All endpoints live in `src/tracker/dashboard.ts`. All take `workflow` as a param — none are workflow-specific.

### 2.1 Retry

```
POST /api/retry
Body: { workflow: string, id: string, runId?: string }
Returns: { ok: true, runId: string } | { ok: false, error: string }
```

Resolution: read the latest tracker entries for `workflow`, find the entry matching `id` (and `runId` if specified), pull `entry.input`, re-enqueue via existing `enqueueFromHttp(...)`. If `entry.input` is missing (legacy entries written before this change), return 410 Gone with "this entry predates retry support; re-run from CLI."

```
POST /api/retry-bulk
Body: { workflow: string, ids: string[] }
Returns: { ok: true, count: number, errors: Array<{id, error}> }
```

Loops `/api/retry`. Reports per-id failures so the UI can surface which ones didn't make it.

### 2.2 Run with data (edit-and-resume)

```
POST /api/run-with-data
Body: { workflow: string, id: string, data: Record<string, unknown> }
Returns: { ok: true, runId: string } | { ok: false, error: string }
```

Reads `entry.input` for the original input, attaches `prefilledData: data`, enqueues. The kernel's prefilled-data channel handles the rest. Server-side validation is the workflow's Zod schema: if the merged `data` doesn't typecheck against expected fields, return 400 with the Zod error message.

### 2.3 Queue mutations

```
POST /api/cancel-queued
Body: { workflow: string, id: string }
Returns: { ok: true } | { ok: false, error: string }

POST /api/queue/bump
Body: { workflow: string, id: string }
Returns: { ok: true } | { ok: false, error: string }
```

Both acquire the existing `fs.mkdir` mutex on `.tracker/daemons/<workflow>.queue.lock` (same pattern `claimNextItem` uses), read the queue state via `readQueueState`, mutate, rewrite. Race protection: if the item has already been claimed by a daemon between the user's click and the lock acquisition, return 409 Conflict with "already claimed by daemon <pid>" — the frontend toasts this distinctly.

`cancel-queued` appends a `cancel` event to the queue JSONL (matching the existing event-sourced format) plus emits a `failed` tracker row with `step: "cancelled"` so the dashboard's failed-state filtering catches it.

`bump` rewrites the queue file: target item moved to position 0, all others retain order. Same lock semantics.

### 2.4 Daemon ops

```
GET /api/daemons?workflow=X
Returns: DaemonInfo[]

interface DaemonInfo {
  workflow: string;
  pid: number;
  port: number;
  startedAt: string;       // ISO
  uptimeMs: number;
  itemsProcessed: number;  // since spawn
  lastKeepalive: string;   // ISO
  currentItem: string | null;
  phase: "launching" | "authenticating" | "idle" | "processing" | "keepalive" | "draining" | "exited";
}
```

Reads `findAliveDaemons(workflow)` from `daemon-registry.ts`, fans out to each daemon's `GET /status` (already exists per `core/CLAUDE.md`) for `phase` + `currentItem`. `itemsProcessed` is computed by reading `.tracker/daemons/<workflow>.queue.jsonl` and counting `done` + `failed` events whose `claimedBy === instanceId` (the queue protocol already records this — no kernel change needed).

```
POST /api/daemons/spawn
Body: { workflow: string, count?: number }  // count defaults to 1
Returns: { ok: true, spawned: number, daemons: DaemonInfo[] }
```

Calls `spawnDaemon(workflow)` `count` times sequentially (Duo isn't parallelizable — each spawn blocks until /whoami succeeds). The endpoint streams back nothing; the frontend toasts "Spawning daemon..." and refreshes `/api/daemons` after the response.

```
POST /api/daemons/stop
Body: { workflow?: string, pid?: number, force?: boolean }
Returns: { ok: true }
```

Wraps `stopDaemons(workflow, force)`. With `pid` set, stops only that daemon (POST to its `/stop` directly). With `workflow` set, stops all daemons for that workflow. With neither, stops all daemons globally.

```
GET /events/daemon-log?pid=X  (SSE)
Stream: { line: string, ts: string }
```

Validates `pid` against the daemon registry (path-traversal guard — only registered PIDs allowed). Tails `.tracker/daemons/<workflow>-<pid>.log` using the same `tail -f`-style file-watcher the `attach` CLI uses. Closes when the daemon exits.

### 2.5 Queue depth on TopBar

The existing `/api/workflows` returns `string[]`. Extend to return `Array<{ name: string, queueDepth: number }>` (or add a new `/api/workflow-counts` endpoint to keep `/api/workflows` backward-compatible). Queue depth: `readQueueState(workflow).items.filter(i => i.status === "queued").length`. Cheap, polled on the existing TopBar refresh cadence.

## Section 3 — Workflow opt-in

For every current workflow, retry, cancel-queued, bump, and daemon ops work without any workflow-level change — they're built on `entry.input` and the queue file, both kernel-level.

Edit-and-resume requires opt-in for workflows with extraction:

### 3.1 Separations (`src/workflows/separations/`)

- `workflow.ts` handler: gate the `kuali-extraction` step on `!ctx.data.employeeName` (or whatever canonical post-extraction field signals "extraction has run"). Pseudo:

  ```ts
  if (!ctx.data.employeeName) {
    await ctx.step("kuali-extraction", async () => { /* existing body */ });
  } else {
    ctx.skipStep("kuali-extraction");  // emits status:"skipped"
  }
  ```
- `index.ts` (registry config): mark editable detailFields. Likely candidates: effective date, separation reason, manager. The current detailFields (Employee, EID, Doc ID) are mostly identifiers and stay non-editable — the editable set should be the fields that drive Kuali timekeeper / UCPath fills, which means we may need to *add* detailFields here, not just flag existing ones.

### 3.2 Onboarding (`src/workflows/onboarding/`) — deferred

Onboarding's `EmployeeData` is ~17 fields (names, SSN, address, wage, dates,
appointment, etc.), and the handler's downstream phases (`pdf-download`,
`person-search`, `i9-creation`, `transaction`) read from a locally-scoped
`data: EmployeeData | null` variable rather than from `ctx.data`. Wiring the
extraction-bypass requires either a synthesize-from-`ctx.data` branch with
~17 field reads, or a refactor to thread the variable through ctx.data
exclusively. Either is bigger than separations and out of scope for this
landing pass — opening a follow-up. Until then, onboarding's edit-and-resume
falls back to "edit-and-rerun-with-prefilled-values-overwritten-by-extraction,"
which is not useful — the dashboard's Edit Data tab will not surface a
"Run with these values" affordance for onboarding entries (handled by
checking the workflow's `editable` detailFields list — empty = no tab).

### 3.3 Other workflows

`work-study`, `emergency-contact`, `eid-lookup`, `oath-signature`, `kronos-reports` have no extraction step. The kernel still merges `prefilledData` into `ctx.data` for them — the extra fields will sit on the entry but the handler won't bypass anything (there's nothing to bypass). Edit-and-resume on these workflows degrades to "edit and re-enqueue with the edited values surfaced in `data`," which is mostly a UX nicety; they have no broken-extraction recovery story because there's no extraction.

## Section 4 — Frontend components

### 4.1 New components

| Component | Lives in | Purpose |
|---|---|---|
| `RetryButton.tsx` | `components/` | Icon button. On `EntryItem` (failed status only) and `LogPanel` header. Confirms via toast, fires `POST /api/retry`. |
| `BulkRetryBar.tsx` | `components/` | Sticky bar inside `QueuePanel`, visible only when ≥1 failed entry is in the current filter view. "Retry N failed" → `POST /api/retry-bulk`. |
| `EditDataTab.tsx` | `components/` | New top-level tab in `LogPanel`, peer to the existing `LogStream` and `ScreenshotsPanel` views (the implementation will introduce a `LogPanel`-level tab switcher if not already present, since today these are stacked rather than tabbed). Renders editable form from `WorkflowMetadata.detailFields.filter(f => f.editable)`. "Run with these values" → `POST /api/run-with-data`. Hidden when no editable fields are declared. |
| `DaemonRow.tsx` | `components/` | Per-daemon row inside `SessionPanel`. Shows pid, uptime, items processed, phase, current item. "Logs" button toggles `DaemonLogTail`; "End" button (existing daemon-end pattern) stays. |
| `DaemonLogTail.tsx` | `components/` | Slide-out under the daemon row. Consumes `/events/daemon-log?pid=X`. Auto-scroll, copy button. |
| `QueueItemControls.tsx` | `components/` | Cancel (X) + Bump (▲) icon buttons. On `EntryItem` for `pending` status only. |
| `QueueDepthPill.tsx` | `components/` | Small badge inside `TopBar` workflow dropdown items. Shows queued count if > 0. |

### 4.2 Modified components

- `EntryItem.tsx` — conditional buttons: failed → `RetryButton`; pending → `QueueItemControls`. Status-driven, no layout shift on running/done.
- `LogPanel.tsx` — header gets `RetryButton` for failed entries; tab list gets `EditDataTab` insertion.
- `QueuePanel.tsx` — wraps `BulkRetryBar` above the entry list. Only renders bar when failed entries are in the current filter view.
- `SessionPanel.tsx` — daemon rows + per-workflow `+ Daemon` and `Stop all` buttons in section headers. Daemon rows replace nothing existing — they sit alongside `WorkflowBox` rows (which are runtime workflow instances, a separate concept).
- `TopBar.tsx` — workflow dropdown items consume the new `queueDepth` field, render `QueueDepthPill` when > 0.

### 4.3 Hooks

- `useDaemons(workflow?)` — polls `GET /api/daemons` every 5s. Returns `DaemonInfo[]`.
- `useDaemonLog(pid)` — SSE consumer for `/events/daemon-log`. Streams lines into a ring buffer (last 500 lines).
- Queue depth: derive from existing entry feed (counting `pending` per workflow) — no new hook needed if we piggyback. Otherwise extend `useWorkflows()` to consume the new `/api/workflow-counts`.

### 4.4 Visual design gate

Before any frontend code is written, run **`ui-ux-pro-max`** with:

- The list of new surfaces from §4.1.
- The existing visual style: dark theme, CSS-vars-only colors, lucide-react icons, mono for IDs/timestamps, sans for names/labels, no emojis, `--radius: 0.5rem`, badge style is subtle tinted background + colored text.
- Constraint: feel native to the existing dashboard. New surfaces should look like they shipped in the same release as the SessionPanel + LogPanel.

Output: a visual spec document covering color/icon/spacing/typography choices for each new surface. Implementation follows the spec — no improvising visual details mid-implementation.

## Section 5 — Build sequence

1. **Kernel foundations** (no UI yet):
   - Persist `entry.input` on pending row.
   - Merge `input.prefilledData` into `ctx.data` before handler runs (via `splitPrefilled`, no input mutation).
   - Add `ctx.skipStep(name)` to `Stepper`, plumbed through `withTrackedWorkflow` to emit `status:"skipped"`.
   - Add `editable?: boolean` to `DetailField` type.
2. **Backend endpoints** (no UI yet):
   - `/api/retry`, `/api/retry-bulk`, `/api/run-with-data`.
   - `/api/cancel-queued`, `/api/queue/bump`.
   - `/api/daemons` (list, spawn, stop), `/events/daemon-log` SSE.
   - `queueDepth` on workflow listing.
3. **Workflow opt-in** (separations + onboarding only):
   - Mark editable detailFields.
   - Add the extraction-skip gate.
4. **Visual design** via `ui-ux-pro-max` — produce visual spec.
5. **Frontend implementation** (per visual spec):
   - `RetryButton`, `BulkRetryBar`.
   - `QueueItemControls` (cancel, bump).
   - `DaemonRow`, `DaemonLogTail`, spawn/stop in `SessionPanel`.
   - `EditDataTab` in `LogPanel`.
   - `QueueDepthPill` in `TopBar`.
6. **Tests**:
   - Unit: kernel input persistence (`tests/unit/core/`), `prefilledData` merge, queue file mutations under contention, retry input reconstruction.
   - Unit: every new endpoint (factory + handler split, like existing `buildSelectorWarningsHandler` pattern).
   - Manual: live test in browser — failed entry → retry → re-runs as #2; cancel queued → vanishes; spawn daemon → appears in panel; edit-and-resume → re-runs with prefilled data, extraction step shows skipped.

## Section 6 — Failure modes & race protection

- **Retry on a stale entry**: if the user clicks Retry and the entry was already retried by someone else, the new run gets a new `runId` regardless. No conflict — `runId` is auto-incremented. Worst case: two concurrent retries → two re-runs. Acceptable.
- **Cancel/bump during claim**: file lock + post-acquire re-check. If item already claimed by daemon, 409 → toast "Already claimed by daemon \<pid\>".
- **Edit-and-resume with bad data**: server-side Zod validation rejects → 400 with field-level error → form highlights bad fields.
- **Daemon log tail after daemon exits**: SSE closes gracefully, frontend toasts "Daemon exited" and unmounts the tail.
- **`entry.input` missing on legacy entries**: 410 Gone → toast "this entry predates retry support; re-run from CLI." Acceptable — the install date for `entry.input` is recent and re-running by CLI is one command.
- **Spawn daemon Duo timeout**: `spawnDaemon` already has a 5min timeout. The endpoint waits for it → frontend toasts "Spawn timed out — check Duo prompt" if it fails.

## Section 7 — Open decisions (none blocking)

- Naming: `Edit Data` tab vs `Manual` vs `Override`. → **Edit Data** (matches dashboard's plain-language norm).
- Retry confirmation: toast confirm vs modal. → **Toast** (lighter, matches existing "loading → success" pattern). For bulk retry on >5 items, a modal with the count.
- Cancel-queued: emit a `failed` row or `skipped` row. → **failed with step:"cancelled"** (so it shows in the FAILED stat pill and can itself be retried if cancelled by mistake).
- `Bump` reorder atomicity when two clicks come in fast: lock serializes them. Last writer wins. UX is noisy if the user clicks twice rapidly but correctness is intact.
