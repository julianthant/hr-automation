import type { SharePointDownloadStatus } from "../../../domain/sharepoint-download-status.js";
import { createPolledResource } from "./resource-factory";

/**
 * Gated poll of `/api/sharepoint-download/status` (every 2.5s) for the roster
 * picker in `RunModal`. Only polls while ≥1 subscriber passes `enabled` (the
 * modal is open on a roster-backed workflow); resets to `null` when the last
 * enabled subscriber unmounts so a closed modal goes quiet.
 *
 * Shallow-compares successive payloads (`statusesEqual`) so an unchanged status
 * doesn't re-render the modal every tick — only a real state change (a download
 * starting/finishing, the queue shifting, a new completion) pushes an update.
 */
const resource = createPolledResource<SharePointDownloadStatus | null>({
  fetcher: async () => {
    const resp = await fetch("/api/sharepoint-download/status");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as SharePointDownloadStatus;
  },
  intervalMs: 2_500,
  initial: null,
  resetWhenIdle: true,
  equals: statusesEqual,
});

/** Shallow structural compare of two status snapshots (drops re-render churn). */
export function statusesEqual(
  a: SharePointDownloadStatus | null,
  b: SharePointDownloadStatus | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.inFlight !== b.inFlight || a.inFlightId !== b.inFlightId) return false;
  if ((a.current?.queueId ?? null) !== (b.current?.queueId ?? null)) return false;
  if ((a.current?.state ?? null) !== (b.current?.state ?? null)) return false;
  if (a.queued.length !== b.queued.length) return false;
  for (let i = 0; i < a.queued.length; i += 1) {
    if (a.queued[i].queueId !== b.queued[i].queueId) return false;
  }
  if ((a.lastCompletion?.ts ?? null) !== (b.lastCompletion?.ts ?? null)) return false;
  if ((a.lastCompletion?.ok ?? null) !== (b.lastCompletion?.ok ?? null)) return false;
  return true;
}

/**
 * Subscribe to the SharePoint download status while `enabled`. Returns `null`
 * when disabled or before the first response. A failed fetch leaves the last
 * value in place (best-effort); the previous inline implementation reset to
 * `null` on error, but retaining the last known status is friendlier to the
 * picker (a transient blip shouldn't drop the "wait" option mid-poll).
 */
export function useSharePointStatus(enabled: boolean): SharePointDownloadStatus | null {
  return resource.useResource(enabled);
}
