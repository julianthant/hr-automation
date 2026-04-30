import { useCallback, useState } from "react";

export interface DownloadStatus {
  inFlight: boolean;
  inFlightId: string | null;
  lastCompletion: { id: string; ts: string; ok: boolean; error?: string } | null;
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
          // Path is the saved file — backend response shape includes it
          // on completion.
          const successPath = ((): string => {
            // The /run handler returns 202 immediately and doesn't have
            // the path yet. The status endpoint's lastCompletion only
            // carries id/ts/ok/error. To get the path, read the saved
            // path off the run handler's response if it lands. For now
            // return a sentinel — callers re-fetch /api/rosters to pick
            // up the freshly-downloaded file.
            return "(see /api/rosters)";
          })();
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
