import { useEffect, useState } from "react";
import type { DaemonInfo } from "@/components/shared/types";

/**
 * Polls `/api/daemons` every 2s and returns the current daemon list. Used
 * by `WorkflowBox` to detect multi-daemon scenarios so the workflow-level
 * stop button can label its blast radius truthfully (a single click on
 * `/api/daemon/stop` tears down EVERY daemon for that workflow, not just
 * the visible card's). Returns an empty array until the first response
 * lands.
 *
 * Kept lightweight on purpose: `/api/daemons` already serves the
 * SQLite-backed worker view in <50ms, so a 2s poll is well within budget
 * and avoids opening a dedicated SSE topic for a UI signal that only
 * needs eventual consistency.
 */
export function useDaemons(): DaemonInfo[] {
  const [daemons, setDaemons] = useState<DaemonInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fetchDaemons = async () => {
      try {
        const res = await fetch("/api/daemons");
        if (!res.ok) return;
        const data = (await res.json()) as DaemonInfo[];
        if (!cancelled) setDaemons(data);
      } catch {
        // best-effort — leave previous state on transient errors.
      }
    };
    void fetchDaemons();
    const interval = setInterval(fetchDaemons, 2_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return daemons;
}
