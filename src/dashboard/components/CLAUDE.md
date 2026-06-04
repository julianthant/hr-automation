# Dashboard Components Organization

This folder is organized by dashboard area. Keep files near the UI surface that owns them; use `shared/` only when more than one area uses the same piece.

## Folders

| Location | Belongs here | Examples |
|---|---|---|
| `navigation/` | Navbar, workflow rail, search, failure popover, and top-bar run/capture affordances. | `TopBar.tsx`, `WorkflowRail.tsx`, `SearchBar.tsx`, `FailureBell.tsx`, `InputRunPanel.tsx` |
| `queue-panel/` | Queue list, queue grouping surfaces, batch drill-in, shared `GroupRowBase`, and queue surface classification. | `QueuePanel.tsx`, `group-row-base.tsx`, `queue-surface-classifier.ts`, `batch-queue-view.tsx`, `EntryItem.tsx`, `StatPills.tsx`, `queue-status.ts` |
| `log-panel/` | Right detail/log column, run selector, step pipeline, screenshots, and edit/retry data view. | `LogPanel.tsx`, `LogStream.tsx`, `LogLine.tsx`, `StepPipeline.tsx`, `ScreenshotsPanel.tsx` |
| `terminal-drawer/` | Bottom session/daemon drawer and browser/session chips. | `TerminalDrawer.tsx`, `WorkflowBox.tsx`, `BrowserChip.tsx`, `LiveIndicator.tsx` |
| `run-modal/` | Generic PDF/file-upload run modal and modal-specific controls. | `RunModal.tsx`, `SharePointDownloadButton.tsx` |
| `capture/` | Capture/photo UI and capture types. Modal internals live in `capture/modal/`. | `CapturePhotoTile.tsx`, `CapturePhotoLightbox.tsx`, `capture-types.ts`, `modal/index.tsx` |
| `ocr/` | OCR/prep review UI and OCR record renderers. `DelegationRow` remains a compatibility wrapper around queue-panel grouping primitives. | `OcrReviewPane.tsx`, `OcrQueueRow.tsx`, `DelegationRow.tsx`, `delegation-row-helpers.ts`, `record-renderers.tsx`, `preview-gate.ts` |
| `oath-upload/` | Oath-upload-only UI pieces. Promote to `shared/` when another workflow starts using them. | `DuplicateBanner.tsx` |
| `shared/` | Cross-area components, shared display helpers, row action buttons, styles, and tracker/dashboard API types. | `EmptyState.tsx`, `RetryButton.tsx`, `RowCancelButton.tsx`, `BumpButton.tsx`, `DeleteButton.tsx`, `PdfPagePreview.tsx`, `MediaLightbox.tsx`, `types.ts`, `entry-display.ts` |
| `hooks/` | React hooks that own client-side state, polling, SSE subscriptions, cache warming, or toast effects. Hooks should not render JSX. | `useEntries.ts`, `useLogs.ts`, `useSessions.ts`, `useRosters.ts` |
| `ui/` | Local shadcn/HeroUI-style primitives only. These should stay generic and workflow-agnostic. | `dialog.tsx`, `popover.tsx`, `tooltip.tsx`, `calendar.tsx` |

## Lessons Learned

- **2026-06-04: Daemon log lines are not shown on session cards.** Machine-scoped `daemon_log` session events are still collected in `tracker/dashboard/session-state.ts` as `WorkflowInstanceState.recentDaemonLogs` (for SSE payload / debugging), but `WorkflowBox` no longer renders them — operators use per-run Logs/Events in the log panel instead. `filterEventsForRun` still drops `daemon_log` from per-run Events tabs. `session-state-equal.ts` ignores `recentDaemonLogs` so new daemon lines do not force session-card re-renders. See `docs/engineering/notes-and-logging-vocabulary.md`.
- **2026-05-31: Tailwind compliance patterns are enforced for component code.** Use Tailwind's built-in animation utilities with `motion-safe:` or `motion-reduce:animate-none`, use `shrink-0` instead of `flex-shrink-0`, keep z-index on the standard `z-*` scale, and give dashboard `<img>` tags `srcSet`, `sizes`, and either `loading` or `fetchPriority`.
- **2026-05-27: Batch PDF rows title by filename before queue title.** `shared/entry-display.ts` must prefer `data.pdfOriginalName` for any `batch` row, not only legacy `mode: "prepare"` rows. This keeps direct and delegated Oath Signature PDF rows titled as the bare PDF filename even when `__queueTitle` carries a workflow-prefixed subject for other surfaces.
