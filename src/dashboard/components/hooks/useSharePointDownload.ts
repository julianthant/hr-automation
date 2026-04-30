import { useCallback, useState } from "react";

export interface DownloadStatus {
  inFlight: boolean;
  inFlightId: string | null;
  lastCompletion: {
    id: string;
    ts: string;
    ok: boolean;
    path?: string;
    filename?: string;
    error?: string;
  } | null;
}

/**
 * Drive a SharePoint download from the browser side: hit
 * `POST /api/sharepoint-download/run` to kick it off, then poll
 * `/api/sharepoint-download/status` every ~1.5s until the in-flight
 * lock clears AND lastCompletion records this id.
 *
 * Returns the saved roster path on success (so the caller can submit
 * the upload immediately afterward), or `null` if anything went wrong
 * (the `error` state holds an actionable string the caller can toast).
 */
export function useSharePointDownload(specId: string) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);

  const start = useCallback(async (): Promise<string | null> => {
    setError(null);
    setResultPath(null);
    setDownloading(true);
    try {
      const resp = await fetch("/api/sharepoint-download/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: specId }),
      });
      if (resp.status === 409) {
        // Already in-flight — fall through to polling; the existing
        // run will land in lastCompletion as long as it's the same id.
      } else if (!resp.ok && resp.status !== 202) {
        const body = (await resp.json()) as { error?: string };
        setError(body.error ?? `HTTP ${resp.status}`);
        setDownloading(false);
        return null;
      }
      // Poll until the in-flight lock clears and lastCompletion matches.
      // Bail out on hard timeout (5 min — should be plenty for a roster
      // download even with Duo).
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const sresp = await fetch("/api/sharepoint-download/status");
        const status = (await sresp.json()) as DownloadStatus;
        if (status.inFlight) continue;
        const completion = status.lastCompletion;
        if (completion && completion.id === specId) {
          if (!completion.ok) {
            setError(completion.error ?? "Download failed");
            setDownloading(false);
            return null;
          }
          // The /api/sharepoint-download/status endpoint surfaces the
          // saved path on lastCompletion (handler picks it up from the
          // workflow's module-level slot after runWorkflow returns).
          // Fall back to /api/rosters if it's missing (older backend or
          // a handler bug) — callers can still re-fetch the listing.
          const successPath = completion.path ?? "(see /api/rosters)";
          setResultPath(successPath);
          setDownloading(false);
          return successPath;
        }
      }
      setError("Download timed out after 5 minutes");
      setDownloading(false);
      return null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDownloading(false);
      return null;
    }
  }, [specId]);

  return { downloading, error, resultPath, start };
}
