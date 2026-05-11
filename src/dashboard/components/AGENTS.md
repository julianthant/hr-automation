# Dashboard Components Organization

This folder is organized by dashboard area. Keep files near the UI surface that owns them; use `shared/` only when more than one area uses the same piece.

## Folders

| Location | Belongs here | Examples |
|---|---|---|
| `navigation/` | Navbar, workflow rail, search, failure popover, and top-bar run/capture affordances. | `TopBar.tsx`, `WorkflowRail.tsx`, `SearchBar.tsx`, `FailureBell.tsx`, `QuickRunPanel.tsx` |
| `queue-panel/` | Left queue column and queue row controls/status helpers. | `QueuePanel.tsx`, `batch-queue-view.tsx`, `EntryItem.tsx`, `StatPills.tsx`, `QueueItemControls.tsx`, `queue-status.ts` |
| `log-panel/` | Right detail/log column, run selector, step pipeline, screenshots, and edit/retry data view. | `LogPanel.tsx`, `LogStream.tsx`, `LogLine.tsx`, `StepPipeline.tsx`, `ScreenshotsPanel.tsx` |
| `terminal-drawer/` | Bottom session/daemon drawer and browser/session chips. | `TerminalDrawer.tsx`, `WorkflowBox.tsx`, `BrowserChip.tsx`, `LiveIndicator.tsx` |
| `run-modal/` | Generic PDF/file-upload run modal and modal-specific controls. | `RunModal.tsx`, `SharePointDownloadButton.tsx` |
| `capture/` | Capture/photo UI and capture types. Modal internals live in `capture/modal/`. | `CapturePhotoTile.tsx`, `CapturePhotoLightbox.tsx`, `capture-types.ts`, `modal/index.tsx` |
| `ocr/` | OCR/prep review UI, delegation batch row, OCR record renderers, and OCR-only types/helpers. | `OcrReviewPane.tsx`, `OcrQueueRow.tsx`, `DelegationRow.tsx`, `delegation-row-helpers.ts`, `record-renderers.tsx`, `preview-gate.ts` |
| `oath-upload/` | Oath-upload-only UI pieces. Promote to `shared/` when another workflow starts using them. | `DuplicateBanner.tsx` |
| `shared/` | Cross-area components, shared display helpers, styles, and tracker/dashboard API types. | `EmptyState.tsx`, `RetryButton.tsx`, `PdfPagePreview.tsx`, `types.ts`, `entry-display.ts` |
| `hooks/` | React hooks that own client-side state, polling, SSE subscriptions, cache warming, or toast effects. Hooks should not render JSX. | `useEntries.ts`, `useLogs.ts`, `useSessions.ts`, `useRosters.ts` |
| `ui/` | Local shadcn/HeroUI-style primitives only. These should stay generic and workflow-agnostic. | `dialog.tsx`, `popover.tsx`, `tooltip.tsx`, `calendar.tsx` |

## Placement Rules

- Put navbar/top-bar/rail work in `navigation/`.
- Put queue list, queue row, retry-all, cancel, bump, and queue status work in `queue-panel/`.
- Put log/detail/screenshot/run-history work in `log-panel/`.
- Put daemon/session/browser drawer work in `terminal-drawer/`.
- Put workflow launch modal work in `run-modal/`; keep workflow-specific launch config in `dashboard/lib/`.
- Put capture/photo work in `capture/`; modal-only subcomponents stay under `capture/modal/`.
- Put hooks in `hooks/`, even when they serve one feature folder.
- Put generic primitives in `ui/`; do not add workflow-specific fetch logic there.
- Prefer named exports. Do not add default exports.

## Promotion Rule

When a feature-private component or helper gets used by a second dashboard area, promote it to `shared/` and update imports in the same change. Do not leave shared behavior hidden inside `navigation/`, `queue-panel/`, `log-panel/`, `ocr/`, `capture/`, or `run-modal/`.

## Import Style

- Use `@/components/...` for cross-folder component imports.
- Use relative imports inside a folder for private sibling components.
- Use `@/components/ui/...` and `@/lib/...` for dashboard-wide primitives and registries.
- Keep folder names lowercase kebab-case so imports work consistently on case-sensitive filesystems.
