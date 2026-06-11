import { createPolledResource } from "./resource-factory";

/**
 * Polls `/api/queue-depth` every 5s. Returns a `{workflow: depth}` map.
 *
 * Module-level singleton (via `createPolledResource`): one fetch + one interval
 * shared across all subscribers. Without this, every WorkflowBox + WorkflowRail
 * mount spins its own poll, and on a busy dashboard those redundant fetches pile
 * up behind the SSE streams that already saturate Chrome's HTTP/1.1
 * 6-per-origin connection pool — manifesting as a refresh hang with hundreds of
 * pending `/api/queue-depth` requests in the network tab.
 */
const resource = createPolledResource<Record<string, number>>({
  fetcher: async () => {
    const res = await fetch("/api/queue-depth");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, number>;
  },
  intervalMs: 5_000,
  initial: {},
});

export function useQueueDepth(): Record<string, number> {
  return resource.useResource();
}
