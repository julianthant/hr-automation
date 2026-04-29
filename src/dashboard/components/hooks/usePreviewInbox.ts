import { useEffect, useState } from "react";
import type { PreviewInboxRow } from "../types";

const POLL_MS = 5_000;

/**
 * Polls /api/preview-inbox every 5 s. Pause via `paused` flag (the
 * ApprovalInbox component sets this true while its popover is open
 * to avoid re-renders that close the menu).
 */
export function usePreviewInbox(paused: boolean = false) {
  const [rows, setRows] = useState<PreviewInboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const fetchOnce = async (): Promise<void> => {
      try {
        const resp = await fetch("/api/preview-inbox");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const body = (await resp.json()) as PreviewInboxRow[];
        if (cancelled) return;
        setRows(body);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchOnce();
    const interval = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [paused]);

  return { rows, loading, error };
}
