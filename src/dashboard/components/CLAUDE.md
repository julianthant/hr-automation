# Dashboard Components Organization

This folder is organized by dashboard area. Keep files near the UI surface that owns them; use `shared/` only when more than one area uses the same piece.

## Folders

| Location | Belongs here | Examples |
|---|---|---|
| `navigation/` | Navbar, workflow rail, search, failure popover, and top-bar run/capture affordances. | `TopBar.tsx`, `WorkflowRail.tsx`, `SearchBar.tsx`, `FailureBell.tsx`, `InputRunPanel.tsx` |
| `queue-panel/` | Queue list, queue grouping surfaces, batch drill-in, shared `GroupRowBase`, and queue surface classification. | `QueuePanel.tsx`, `group-row-base.tsx`, `queue-surface-classifier.ts`, `batch-queue-view.tsx`, `EntryItem.tsx`, `StatPills.tsx`, `QueueItemControls.tsx`, `queue-status.ts` |
| `log-panel/` | Right detail/log column, run selector, step pipeline, screenshots, and edit/retry data view. | `LogPanel.tsx`, `LogStream.tsx`, `LogLine.tsx`, `StepPipeline.tsx`, `ScreenshotsPanel.tsx` |
| `terminal-drawer/` | Bottom session/daemon drawer and browser/session chips. | `TerminalDrawer.tsx`, `WorkflowBox.tsx`, `BrowserChip.tsx`, `LiveIndicator.tsx` |
| `run-modal/` | Generic PDF/file-upload run modal and modal-specific controls. | `RunModal.tsx`, `SharePointDownloadButton.tsx` |
| `capture/` | Capture/photo UI and capture types. Modal internals live in `capture/modal/`. | `CapturePhotoTile.tsx`, `CapturePhotoLightbox.tsx`, `capture-types.ts`, `modal/index.tsx` |
| `ocr/` | OCR/prep review UI and OCR record renderers. `DelegationRow` remains a compatibility wrapper around queue-panel grouping primitives. | `OcrReviewPane.tsx`, `OcrQueueRow.tsx`, `DelegationRow.tsx`, `delegation-row-helpers.ts`, `record-renderers.tsx`, `preview-gate.ts` |
| `oath-upload/` | Oath-upload-only UI pieces. Promote to `shared/` when another workflow starts using them. | `DuplicateBanner.tsx` |
| `shared/` | Cross-area components, shared display helpers, styles, and tracker/dashboard API types. | `EmptyState.tsx`, `RetryButton.tsx`, `PdfPagePreview.tsx`, `MediaLightbox.tsx`, `types.ts`, `entry-display.ts` |
| `hooks/` | React hooks that own client-side state, polling, SSE subscriptions, cache warming, or toast effects. Hooks should not render JSX. | `useEntries.ts`, `useLogs.ts`, `useSessions.ts`, `useRosters.ts` |
| `ui/` | Local shadcn/HeroUI-style primitives only. These should stay generic and workflow-agnostic. | `dialog.tsx`, `popover.tsx`, `tooltip.tsx`, `calendar.tsx` |
