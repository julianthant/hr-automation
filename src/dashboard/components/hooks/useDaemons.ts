import type { DaemonInfo } from "@/components/shared/types";
import { createPolledResource } from "./resource-factory";

/**
 * Polls `/api/daemons` every 2s and returns the current daemon list. Used to
 * detect multi-daemon scenarios (e.g. so a stop button can label its blast
 * radius truthfully). Returns an empty array until the first response lands.
 *
 * `/api/daemons` serves the SQLite-backed worker view in <50ms, so a 2s poll is
 * well within budget and avoids opening a dedicated SSE topic for a UI signal
 * that only needs eventual consistency. One shared poll across all subscribers
 * (see `createPolledResource`) keeps it off Chrome's 6-per-origin budget.
 */
const resource = createPolledResource<DaemonInfo[]>({
  fetcher: async () => {
    const res = await fetch("/api/daemons");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as DaemonInfo[];
  },
  intervalMs: 2_000,
  initial: [],
});

export function useDaemons(): DaemonInfo[] {
  return resource.useResource();
}
