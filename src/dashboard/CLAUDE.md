# Dashboard — Implementation Guide

React SPA for real-time HR workflow monitoring. Split-panel layout: queue (left) + log stream (right).

## Stack

- React 19, Vite 8, Tailwind CSS v4, shadcn/ui primitives, lucide-react, sonner (toasts)
- HeroUI (`@heroui/react`, `@heroui/calendar`, `@heroui/styles`) — used for the date Calendar in `components/ui/calendar.tsx` and its global stylesheet imported from `index.css`. Other shadcn-style primitives (button, dropdown, popover, etc.) are local files in `components/ui/`.
- Theme: CSS variables and Tailwind v4 setup live in `index.css` (no root-level `theme.md` in this repo)
- Fonts: Inter (sans), JetBrains Mono (mono) — loaded via Google Fonts in `index.html`
- No framer-motion

## Operator text conventions

Dashboard toasts, queue actions, delegation batch rows, and batch member rows should render the shared operator subject first (`data.__subject`). Do not display raw run ids/session ids as primary text unless no subject exists; keep those ids as fallback or debug detail.

Dashboard controls mutate the SQLite control plane first (`tasks`, `task_attempts`, `worker_commands`, `browser_processes`) and let workers observe those commands. JSONL tracker/queue writes are audit/history, not live coordination. Browser force-stop controls must target a recorded `browser_processes` row; do not add a control that kills all Chromium processes or only flips local React state.

## Component Tree

Component placement rules live in `components/CLAUDE.md`. Read that file before adding, moving, or promoting files under `src/dashboard/components/`.

```
App.tsx
├── navigation/TopBar.tsx
│   ├── Workflow dropdown (shadcn Select → popover with name + count)
│   ├── Date navigation (arrow buttons + shadcn Popover + Calendar)
│   ├── SearchBar.tsx (cross-workflow tracker entry search → SearchResults.tsx)
│   ├── FailureBell.tsx (red badge with read-state — failed entries on the active date, persists read status via localStorage)
│   ├── Live indicator (green dot pill)
│   └── Clock (useClock hook)
├── queue-panel/QueuePanel.tsx
│   ├── StatPills.tsx (5 clickable cards — hidden in batch queue mode)
│   ├── batch-queue-view `BatchQueueToolbar` — back link + batch title (batch queue mode only)
│   └── Entry list (scroll)
│       ├── ocr `DelegationRow` — approved prep delegation summary; click → batch queue mode
│       ├── batch-queue-view `BatchQueueMemberList` — scoped member `EntryItem` rows (batch queue mode)
│       └── `EntryItem.tsx` — main queue rows (name, badge, step, time, error)
├── log-panel/LogPanel.tsx
│   ├── Header (name, badge, email, RunSelector.tsx)
│   ├── Detail grid (4 cells, varies per workflow)
│   ├── StepPipeline.tsx (horizontal dots + connectors + timing)
│   ├── LogStream.tsx (shadcn ScrollArea; filter tabs + debug-log visibility toggle)
│   │   └── LogLine.tsx × N (timestamp, icon, message, dup badge, copy)
│   └── Footer (streaming indicator, count, auto-scroll toggle)
└── terminal-drawer/TerminalDrawer.tsx (bottom bar + horizontal session cards)
    └── WorkflowBox.tsx × N — **`StopPill`** → `POST /api/daemon/stop` (workflow-wide, after confirm). **`BrowserChip`** tiles are auth-state labels only (`useDaemons` + `/api/daemons` inform copy, not per-chip kill).
```

## Backend Wiring (SSE API on port 3838)

The HTTP server is created in `src/tracker/dashboard/server.ts` (`createDashboardServer`); routing is Hono under `src/tracker/dashboard/hono/`. Public imports often go through `src/tracker/dashboard.ts` (barrel). The Vite dev server (port 5173) proxies `/api/*` and `/events/*` via `vite.dashboard.config.ts`; `dashboard --prod` serves `dist/dashboard/index.html` from the same Hono server.

### Endpoints

→ Full reference: `docs/engineering/dashboard-api-reference.md`

### Data Types (shared between backend and frontend)

→ Full reference: `docs/engineering/dashboard-api-reference.md`

### JSONL Files (`.tracker/`)

→ Full reference: `docs/engineering/dashboard-api-reference.md`

## How Frontend Processes Data

→ Full reference: `docs/engineering/dashboard-api-reference.md`

## Workflow-Specific Configuration

All dashboard UI metadata lives on the server-side `WorkflowMetadata` registry (every shipped workflow registers via `defineWorkflow`). Frontend consumes via the `WorkflowsProvider` + `useWorkflow(name)` hook (`src/dashboard/lib/workflows-context.tsx`) backed by `/api/workflow-definitions`. The former `WF_CONFIG` constant was deleted in subsystem D — there is no frontend-side hardcoding of labels, name/id resolvers, or detailField arrays anywhere.

→ Full reference (per-workflow archetype/steps/detailFields table): `docs/engineering/dashboard-api-reference.md`

## Hook → Component Mapping

→ Full reference: `docs/engineering/dashboard-api-reference.md`

## Log Icon Mapping (lucide-react)

→ Full reference: `docs/engineering/dashboard-api-reference.md`

## Toast Events

→ Full reference: `docs/engineering/dashboard-api-reference.md`

## Styling Rules

→ Full reference: `docs/engineering/dashboard-api-reference.md`

## Build

```bash
npm run dev:dashboard     # Vite dev on :5173, proxies /api + /events to :3838
npm run build:dashboard   # Single-file HTML to dist/dashboard/index.html
npm run dashboard         # Starts SSE backend (:3838) + Vite dev (:5173)
npm run dashboard:watch   # Same as dashboard, but tsx watch restarts SSE backend on src/ changes (full restart, not HMR)
npm run dashboard:prod    # Serve pre-built dashboard from SSE only (no Vite)
npm run dashboard:tunneled  # Dashboard with tunnel support (expose SSE to external clients)
```

## Adding a New Workflow to the Dashboard

The dashboard now auto-adapts — no frontend changes needed. When a new workflow lands:

1. **Kernel workflow** — declare `label`, `getName`, `getId`, and labeled `detailFields` inside the `defineWorkflow(...)` config. The registry + `/api/workflow-definitions` picks them up automatically; the detail grid renders whatever is declared.
2. **Log icon mapping** — if the workflow introduces new log message patterns, add them to the icon mapping in `LogLine.tsx`.
3. **Test** — run `npm run dashboard`, trigger the workflow, verify entries appear and steps progress. The detail panel should populate from your declared `detailFields` via `updateData` calls in the handler.

## Lessons Learned

- **Lesson maintenance rule:** Before adding a dashboard lesson, search this section for the same feature or failure mode. Merge stale notes into the current rule, remove contradictions, and keep historical implementation details only when they explain a still-current gotcha.
- **2026-05-27: Workflow definitions require eager dashboard registration.** `/api/workflow-definitions` reads the in-process `defineWorkflow` registry, so `src/tracker/dashboard/workflows.ts` must eagerly import every shipped dashboard workflow barrel. Lazy daemon loaders alone are not enough; otherwise the rail only shows workflows whose route modules happened to be imported at dashboard startup, such as OCR and SharePoint Download.
- **Queue surfaces and actions:** Queue rendering flows through `buildTrackerQueueSurfaces` -> `WorkflowRunProjection` -> queue components. New row types should extend the classifier/projection layer and `GroupRowBase` wrappers, not add workflow-specific branches in `QueuePanel`. Projection actions must carry concrete `targets` (`workflowId`, `id`, `runId?`, `date?`, `status?`), and all row/bulk controls should dispatch through `useWorkflowActionDispatcher` so scope/source survive to `performWorkflowAction`.
- **Prep and delegation cards:** Prep/upload batch-parent rows are operator actions, so their surface kind should stay stable across review/approval. A single approved prep row with one visible child remains an `approval-delegation` card; a prep row with no visible members can render flat. Multi-file upload is intentionally N independent single-file prep runs, not one grouped parent card.
- **OCR discard and review:** OCR prep discard/cancel must travel through `/api/cancel-queued` or `/api/task/force-stop` with OCR context (`ocrSessionId`, OCR `runId`, parent row fields, `formType`, `reason`). Do not resurrect `/api/ocr/discard-prepare`. Delegated OCR review rows at `status=done` / `step=awaiting-approval` are still action-capable: keep `Needs review` plus normal retry/delete footer controls.
- **Titles:** Use queue-title metadata first for non-person rows (`__queueRootTitle`, `__queueTitle`), but person/delegated rows keep `name`, `employeeName`, `searchName`, or valid EID as the visible title. Never promote technical ids such as `ocr-oath-*`, `ocr-retry-*`, raw run ids, or parent ids to primary row text.
- **SSE:** All real-time dashboard streams use one `/events/hub` EventSource. Topic emitters live in `src/tracker/dashboard/hono/topics-emitters.ts`; frontend subscriptions use `src/dashboard/lib/sse-hub.ts`. Listener errors must be logged without killing other listeners, first-tick flags reset after SSE errors, and `useEntries` validates the shallow `{sub,data,event?}` envelope before state updates. Projection-backed topics must resolve the current `state.db` handle on each tick; a live dashboard can outlive a `.tracker/state.db` delete/recreate and must not keep serving a stale SQLite connection.
- **TopBar and run launchers:** `FailureBell` replaced the old approval inbox and lazy-fetches `/api/failures` only when opened while counts ride the `entries` hub payload. Dashboard workflow starts have two canonical surfaces: upload runs (`RunModal` + `RUN_MODAL_REGISTRY`) and input runs (`InputRunPanel` + `INPUT_RUN_REGISTRY`). Unknown workflow configs must not fall back silently, and the hook-order guard (`if (!config) return null` after hooks) still applies.
- **2026-05-25: Dashboard run surfaces centralized.** Direct workflow starts were removed from `src/cli.ts` and package scripts; operators should start workflows from the dashboard upload-run or input-run affordances only. `/api/enqueue` rejects workflows not listed in `DASHBOARD_INPUT_RUN_WORKFLOWS`, so YAML/batch-file launch paths such as old Kronos `batch.yaml` are not valid dashboard input-run targets.
- **OCR review UI:** `OcrReviewPane` renders successful records and failed page cards in `sourcePage` order. Re-OCR and per-page retry clear local edits for affected pages, preserve `data-pair-index` instrumentation on successful records, and avoid nested modals that break review context.
- **Core UX conventions:** Keep workflow/date/selection in URL params, always show a run indicator when at least one run exists, use `var(--token)` directly for CSS variables that already contain `hsl(...)`, keep the session drawer visible with a "No active workflows" placeholder, and use `firstLogTs` / `lastLogTs` consistently for elapsed time.
- **Historical removals that should stay removed:** The generic dashboard runner, command palette replacement for search, inline failure drill-down strip, step-cache visualization, daemonLog topic, and `/api/preview-inbox` are gone. Do not re-add them unless there is a new explicit design.
- **Testing gap:** The dashboard still lacks a browser/component test harness (`@testing-library/react` / `jsdom`). Pure queue/projection logic has unit tests; visual/component changes still need lint, typecheck, dashboard build, and manual dashboard verification until a harness is added.

## Frontend Files

→ Full reference: `docs/engineering/dashboard-api-reference.md`
