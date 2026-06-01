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
- **Unified footer contract (2026-06-01, status-gated):** Every flat queue footer (`EntryItem`, including batch members) renders one ordered button schema — `time · #run · id · ⟨spacer⟩ · elapsed/duration · ▲ bump · ↻ retry · × cancel · 🗑 delete`. Each button self-hides on its kernel action descriptor's `enabled` flag; **the projection sets `enabled` per status** via `rowActionEnabledForStatus` (`src/domain/workflow-runtime/projection.ts`), the single source of truth for the matrix: **running → ×** · **queued → ▲ × 🗑** · **done/failed → ↻ 🗑** (cancelled is `failed`+`step=cancelled` → terminal → ↻ 🗑). The buttons (`BumpButton`, `RetryButton`, `RowCancelButton`, `DeleteButton` in `shared/`) still never branch on `entry.status` themselves — they only read descriptors — so the schema stays kernel-driven; status-gating lives in the projection, not the component. The default policy carries all four row actions (`DEFAULT_ROW_ACTIONS`, `default-policy.ts`); workflows inherit them. `RowCancelButton` routes by the cancel target's status (running → `status:"running"`, queued → queued handler, OCR-prep → discard) via the pure `buildRowCancelDispatchArgs` (`lib/row-cancel-request.ts`). This **replaces** the prior "always retry+delete, no status gating" rule and the dead `CancelRunningButton`/`QueueItemControls` (removed). The toolbar Stop + drawer `StopPill` remain the daemon-scoped stop; the footer × is the per-row cancel.
  - **Batch/group footers** (`DaemonBatchRow`/`DelegationRow` via `BatchFooterActions`/`ApprovalDelegationFooterActions`) keep their own bulk selection (retry-all / delete-all / cancel-all over members); they are not status-gated per the matrix above (a group spans mixed-status members). Don't bump a group.
- **2026-06-01: 0-member batch footers fall back to the anchor.** `DaemonBatchRow` derived footer time / elapsed / retry+delete from `memberEntries`, so a `batch` anchor with no members yet (e.g. the oath-signature PDF row during OCR approval — visible under the "all" filter via `queueGroupMatchesStatusFilter(null, []) === true`) rendered a degenerate footer (bare `#run`, no time/elapsed/actions). Fix: `DaemonBatchRow` takes an `anchorEntry` prop and uses `footerEntries = members.length ? members : [anchor]` for `firstTimestamp`, `elapsedEntries`, and `BatchFooterActions` targets; `members` stays empty so the count badge/progress bar still read 0/0. `QueuePanel` passes `anchorEntry={surface.parent}`. Surfaced by the dev UI gallery's ("?view=ui-gallery") "0 members (pre-fan-out)" variant — the gallery reuses the real component, so footer regressions show up there.
- **Prep and delegation cards:** OCR rows are `preview`; batch rows are real batch anchors. Multi-file upload is N independent preview runs, not one grouped parent card.
- **Status:** Queue row status semantics resolve from per-workflow **`statusExtensions`** (declared on `defineWorkflow`) via `src/domain/queue-row-status.ts` — the single source for `EntryItem`'s derived status (`notFound`, `needsReview`) and supplemental tag (person-lookup A/IA). `EntryItem` is workflow-agnostic: it calls `resolveQueueRowStatus(entry, { isDone })` and renders whatever comes back; the universal `cancelled` override + 5 base statuses stay in the component. Rule objects live client-bundle-safe in the domain/tracker layers (`person-lookup-status.ts`, `tracker/dashboard/ocr-status.ts`) and are registered for the client via the side-effect import `domain/queue-row-status-index.ts` (defineWorkflow never runs in the bundle). Never branch on `entry.workflow === "..."` for status in the dashboard.
- **Titles:** Queue row title/subtitle resolve from **kind** (`data.queueRowKind`: person/file/catalog) via `src/domain/queue-row-presentation.ts` — the single source for `resolveEntryName`/`resolveEntryId` (`shared/entry-display.ts`) and projection `batchGroupTitle`. person → resolved name (subtitle EID, else trace id); file → PDF filename; catalog → spec label; **person batch anchor → no title** (count badge + member preview identify it). Never promote technical ids to primary text; do not hardcode workflow titles in the dashboard.
- **No title ordinals:** Session-local ordinals (`OATH 1`, `<label> · #1234`, `Roster 2`) are retired. Disambiguate by the footer's time + `#run`. `resolveDaemonBatchQueueTitle` → titleOverride, else a member's `pdfOriginalName`, else `""`. A lone daemon drops its ` 1` suffix on display (`WorkflowBox.displayInstance`); concurrent instances keep their number for start/end pairing.
- **SSE:** Real-time streams use one `/events/hub` EventSource. Listener errors must not kill other listeners, and projection-backed topics must resolve the current `state.db` handle each tick.
- **Run launchers:** Operators start workflows through upload runs (`RunModal` + `RUN_MODAL_REGISTRY`) or input runs (`InputRunPanel` + `INPUT_RUN_REGISTRY`).
- **Input-bar row shape is count-based.** One parsed value is flat; multiple parsed values become one batch row.
- **2026-05-30: `buildDisplayNameMap` ordinal machinery removed (dead since queue row kind landed).** Stamped rows resolve title via `resolveQueueRowPresentation` (queue row kind), which wins inside `resolveEntryName` before the displayNames map is consulted — so the session-local "<base> <n>" numbering (the `ordinal` flag, the `totals` counting pass, the `counters` loop) was dead for every production row. The map now only emits bare base names for legacy/unstamped rows + the delegated-label inheritance walk. The one preserved nuance: a lone bare workflow-label fallback (e.g. a single "Separation" doc with no person name) is still omitted from the map so `resolveEntryName` falls through to its richer `__subject`. Behavior-neutral: scenario snapshots unchanged; the OATH/EMPL unit assertions dropped their ` 1` suffix (the map output, never seen in prod where OCR rows are kind `file`).
- **2026-05-30: Per-workflow status rules moved out of EntryItem into `statusExtensions`.** `EntryItem` no longer branches on `entry.workflow` for the A/IA tag or the `notFound`/`needsReview` derived statuses. The rules live in `WorkflowConfig.statusExtensions` (`derivedStatus` + `secondaryTag`), resolved generically by `resolveQueueRowStatus` (`src/domain/queue-row-status.ts`). Client registration is via the side-effect import `domain/queue-row-status-index.ts`. Behavior-neutral refactor — pinned by `tests/unit/domain/queue-row-status.test.ts`. Gotcha: `statusExtensions` is OPTIONAL, so no "every workflow must declare it" guard (that would be wrong).
- **2026-05-28: Retired workflows are filtered at the dashboard payload boundary.** `active-check` and `eid-lookup` tracker history can remain on disk, but `/events` workflow metadata and `/api/workflows` filter them out so the rail only exposes Person Lookup.
- **OCR review UI:** Preserve source-page ordering, retry/re-OCR page isolation, and `data-pair-index` instrumentation.
- **Testing gap:** There is no browser/component harness yet. Pure projection logic has unit tests; visual changes need lint, typecheck, dashboard build, and manual dashboard verification.
- **2026-05-31: Desktop Tailwind compliance is guarded by architecture tests.** `tests/unit/architecture/frontend-tailwind-compliance.test.ts` blocks dashboard regressions for custom keyframes/inline animation, arbitrary `z-[...]`, old `flex-shrink-0`, motion-unsafe Tailwind animations, and `<img>` tags without `srcSet`/`sizes` plus explicit loading priority. The dashboard remains desktop-only; do not add mobile-only layout requirements unless the product scope changes.
