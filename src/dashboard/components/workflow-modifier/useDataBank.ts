import { useEffect, useState } from "react";
import type { DataBank } from "../../../domain/workflow-design/data-bank.js";

/**
 * Load the assembled Data Bank once (`GET /api/data-bank`) — the n8n-style
 * palette of every system operation + each workflow's real automation, built by
 * `npm run data-bank:build`. Workflow-agnostic, so it is fetched a single time
 * and shared across the editor. Degrades to `null` (no palette) on absence.
 */
export function useDataBank(): { bank: DataBank | null; loaded: boolean } {
  const [bank, setBank] = useState<DataBank | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/data-bank")
      .then((r) => {
        if (!r.ok) throw new Error(`data-bank ${r.status}`);
        return r.json();
      })
      .then((b: { ok?: boolean; bank?: DataBank | null }) => {
        if (!live) return;
        setBank(b.ok ? b.bank ?? null : null);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (live) {
          console.warn("data-bank fetch failed", err);
          setLoaded(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  return { bank, loaded };
}
