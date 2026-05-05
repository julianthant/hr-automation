export {
  startDashboard,
  createDashboardServer,
  stopDashboard,
} from "./dashboard/server.js";
export type {
  StartDashboardOptions,
  CreateDashboardServerOptions,
} from "./dashboard/server.js";

export {
  getEventSortKey,
  resolveInstanceForRun,
  filterEventsForRun,
  rebuildSessionState,
} from "./dashboard/session-state.js";
export type {
  BrowserState,
  SessionInfo,
  WorkflowInstanceState,
  DuoQueueEntry,
  SessionState,
} from "./dashboard/session-state.js";

export {
  SCREENSHOTS_DIR,
  buildScreenshotsHandler,
  resolveScreenshotPath,
} from "./dashboard/screenshots.js";
export type {
  ScreenshotListEntry,
  ScreenshotGroupedEntry,
} from "./dashboard/screenshots.js";

export {
  buildSearchSummary,
  buildSearchHandler,
} from "./dashboard/search.js";
export type {
  SearchDeps,
  SearchResultRow,
} from "./dashboard/search.js";

export {
  buildPreviewInboxHandler,
} from "./dashboard/preview-inbox.js";
export type {
  PreviewInboxDeps,
  PreviewInboxRow,
} from "./dashboard/preview-inbox.js";

export {
  buildFailuresHandler,
  computeFailureCounts,
} from "./dashboard/failures.js";
export type {
  FailuresDeps,
  FailureRow,
} from "./dashboard/failures.js";

export {
  buildSelectorWarningsHandler,
} from "./dashboard/selector-warnings.js";
export type {
  SelectorWarningRow,
} from "./dashboard/selector-warnings.js";

export {
  computeStepDurations,
  buildRunTimelines,
} from "./dashboard/run-timelines.js";
export type {
  RunTimeline,
} from "./dashboard/run-timelines.js";

export {
  __resetFailureAlertCooldown,
  scanFailurePatterns,
  scanOrphanedQueueItems,
} from "./dashboard/sweeps.js";

export {
  buildWorkflowsHandler,
} from "./dashboard/routes/base.js";

export {
  isDownloadInFlight as isRosterDownloadInFlight,
} from "../workflows/sharepoint-download/index.js";
export type {
  RosterDownloadResponse,
  RosterDownloadHandlerOptions,
} from "../workflows/sharepoint-download/index.js";
