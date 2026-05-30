# Dashboard

React SPA for real-time workflow monitoring: queue on the left, log/detail surface on the right.

## Stack

- React 19, Vite 8, Tailwind CSS v4, shadcn/ui primitives, lucide-react, sonner.
- HeroUI is only used for the date calendar and its stylesheet.
- Theme tokens live in `index.css`; fonts are Inter and JetBrains Mono.
- No framer-motion.

## Operator Text

Use the shared operator subject (`data.__subject`) as primary text for toasts, queue rows, delegation batches, and batch members. Raw run ids/session ids are fallback or debug detail only.

Dashboard controls mutate SQLite control state first and let workers observe commands. JSONL writes are audit/history. Do not add controls that only flip React state or indiscriminately kill Chromium processes.

## Backend

The SSE/API server is Hono under `src/tracker/dashboard/hono/`, created by `src/tracker/dashboard/server.ts`. Vite dev runs on `:5173` and proxies `/api/*` + `/events/*` to `:3838`; prod serves the built dashboard from the Hono server.

Full API and event reference: `docs/engineering/dashboard-api-reference.md`.

## Workflow Metadata

Frontend labels, detail fields, steps, and display helpers come from the server-side workflow registry via `/api/workflow-definitions`. Do not add frontend-side workflow label/detail hardcoding.

For a new workflow:
- Declare `label`, `getName`, `getId`, and `detailFields` in `defineWorkflow`.
- Add log icon patterns only if new message patterns need icons.
- Run the dashboard and verify entries, steps, and detail fields populate from `ctx.updateData`.

## Build

```bash
npm run dev:dashboard
npm run build:dashboard
npm run dashboard
npm run dashboard:watch
npm run dashboard:prod
npm run dashboard:tunneled
```

## Lessons Learned

- **Lesson maintenance rule:** Keep current UI contracts here; move reference tables to `docs/engineering/dashboard-api-reference.md`.
- **Workflow definitions require eager registration.** `/api/workflow-definitions` reads the in-process `defineWorkflow` registry, so `src/tracker/dashboard/workflows.ts` must import every dashboard workflow barrel.
- **Queue surfaces and actions:** Extend classifier/projection layers and `GroupRowBase` wrappers for new row types. Dispatch row/bulk controls through `useWorkflowActionDispatcher` so scope/source reach `performWorkflowAction`.
- **Prep and delegation cards:** OCR rows are `preview`; batch rows are real batch anchors. Multi-file upload is N independent preview runs, not one grouped parent card.
- **Titles:** Queue row title/subtitle resolve from **kind** (`data.queueRowKind`: person/file/catalog) via `src/domain/queue-row-presentation.ts` — the single source for `resolveEntryName`/`resolveEntryId` (`shared/entry-display.ts`) and projection `batchGroupTitle`. person → resolved name (subtitle EID, else trace id); file → PDF filename; catalog → spec label; **person batch anchor → no title** (count badge + member preview identify it). Never promote technical ids to primary text; do not hardcode workflow titles in the dashboard.
- **No title ordinals:** Session-local ordinals (`OATH 1`, `<label> · #1234`, `Roster 2`) are retired. Disambiguate by the footer's time + `#run`. `resolveDaemonBatchQueueTitle` → titleOverride, else a member's `pdfOriginalName`, else `""`. A lone daemon drops its ` 1` suffix on display (`WorkflowBox.displayInstance`); concurrent instances keep their number for start/end pairing.
- **SSE:** Real-time streams use one `/events/hub` EventSource. Listener errors must not kill other listeners, and projection-backed topics must resolve the current `state.db` handle each tick.
- **Run launchers:** Operators start workflows through upload runs (`RunModal` + `RUN_MODAL_REGISTRY`) or input runs (`InputRunPanel` + `INPUT_RUN_REGISTRY`).
- **Input-bar row shape is count-based.** One parsed value is flat; multiple parsed values become one batch row.
- **2026-05-28: Retired workflows are filtered at the dashboard payload boundary.** `active-check` and `eid-lookup` tracker history can remain on disk, but `/events` workflow metadata and `/api/workflows` filter them out so the rail only exposes Person Lookup.
- **OCR review UI:** Preserve source-page ordering, retry/re-OCR page isolation, and `data-pair-index` instrumentation.
- **Testing gap:** There is no browser/component harness yet. Pure projection logic has unit tests; visual changes need lint, typecheck, dashboard build, and manual dashboard verification.
