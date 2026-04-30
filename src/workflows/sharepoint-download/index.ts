/**
 * Barrel for the `sharepoint-download` kernel workflow.
 *
 * Importing this module triggers the side-effect `defineWorkflow()` call
 * inside `workflow.ts`, which registers the workflow metadata with the
 * global registry. `src/tracker/dashboard.ts` imports from here, which is
 * how the workflow ends up in `/api/workflow-definitions` + the TopBar
 * dropdown.
 */
export {
  sharepointDownloadWorkflow,
  runSharePointDownload,
  _setPendingLandingUrl,
} from "./workflow.js";
export {
  downloadSharePointFile,
  loginToSharePoint,
  captureExcelDownload,
  clickExcelDownloadMenu,
} from "./download.js";
export type { DownloadSharePointOptions } from "./download.js";
export {
  buildSharePointRosterDownloadHandler,
  buildSharePointListHandler,
  isDownloadInFlight,
  getSharePointDownloadStatus,
  _resetInFlightForTests,
} from "./handler.js";
export type {
  RosterDownloadResponse,
  RosterDownloadHandlerOptions,
  SharePointDownloadListItem,
} from "./handler.js";
export { SharePointDownloadInputSchema } from "./schema.js";
export type { SharePointDownloadInput } from "./schema.js";
export {
  SHAREPOINT_DOWNLOADS,
  getDownloadSpec,
  listDownloadIds,
} from "./registry.js";
export type { SharePointDownloadSpec } from "./registry.js";
