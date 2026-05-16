import { useEffect, useState } from "react";
import type { DaemonInfo } from "@/components/shared/types";

let cache: DaemonInfo[] = [];
const subscribers = new Set<(daemons: DaemonInfo[]) => void>();
let interval: ReturnType<typeof setInterval> | null = null;
let inflight = false;

type HotImportMeta = ImportMeta & {
  hot?: { dispose: (cb: () => void) => void };
};

const hot = (import.meta as HotImportMeta).hot;
if (hot) {
  hot.dispose(() => {
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    subscribers.clear();
  });
}

async function fetchDaemons(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const res = await fetch("/api/daemons");
    if (!res.ok) return;
    cache = (await res.json()) as DaemonInfo[];
    for (const cb of subscribers) cb(cache);
  } catch {
    // best-effort — leave previous state on transient errors.
  } finally {
    inflight = false;
  }
}

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
  const [daemons, setDaemons] = useState<DaemonInfo[]>(cache);

  useEffect(() => {
    subscribers.add(setDaemons);
    void fetchDaemons();
    if (subscribers.size === 1) {
      interval = setInterval(fetchDaemons, 2_000);
    }
    return () => {
      subscribers.delete(setDaemons);
      if (subscribers.size === 0 && interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
  }, []);

  return daemons;
}
