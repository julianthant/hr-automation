/**
 * Type-only contract for the SharePoint-download status snapshot returned by
 * `getSharePointDownloadStatus` (`src/workflows/sharepoint-download/handler.ts`)
 * and served at `GET /api/sharepoint-download/status`.
 *
 * Lives in `domain/` so both the server handler and the client `RunModal` can
 * type the same shape WITHOUT the client importing server runtime code. The
 * handler annotates its return value with {@link SharePointDownloadStatus}; the
 * modal imports the type for its `fetch` parse. Keeping one source of truth
 * means a field added on the server (e.g. `inFlightId`, per-job `queueId` /
 * `createdAt`, `lastCompletion.path` / `filename` / `error`) is visible to the
 * client instead of being silently dropped by a lossy re-declaration.
 */

/** A queued or currently-running SharePoint download job. */
export interface SharePointDownloadJobStatus {
  /** Serial queue id, e.g. `spq-3`. Distinct from the registry `id`. */
  queueId: string;
  /** Registry download id (the spec id). */
  id: string;
  /** Human-facing spec label. */
  label: string;
  state: "running" | "queued";
  /** ISO timestamp the job was enqueued. */
  createdAt: string;
}

/** The most recent done/failed download run. */
export interface SharePointDownloadCompletion {
  /** Registry download id of the completed run. */
  id: string;
  /** ISO completion timestamp. */
  ts: string;
  /** True when the run succeeded. */
  ok: boolean;
  /** Downloaded file path (success only). */
  path?: string;
  /** Downloaded file name (success only). */
  filename?: string;
  /** Failure message (failure only). */
  error?: string;
}

/**
 * Snapshot of the SharePoint serial download queue for poll-while-uploading
 * consumers (`RunModal`'s roster picker). Matches the runtime shape returned by
 * `getSharePointDownloadStatus`.
 */
export interface SharePointDownloadStatus {
  /** True while a download is actively running. */
  inFlight: boolean;
  /** Registry id of the in-flight run, or `null` when idle. */
  inFlightId: string | null;
  /** The currently-running job, or `null` when idle. */
  current: (SharePointDownloadJobStatus & { state: "running" }) | null;
  /** Jobs waiting behind `current`, oldest first. */
  queued: Array<SharePointDownloadJobStatus & { state: "queued" }>;
  /** The most recent terminal run, or `null` when none has finished this session. */
  lastCompletion: SharePointDownloadCompletion | null;
}
