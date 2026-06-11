import { createPolledResource } from "./resource-factory";

/**
 * Shared 1Hz clock. One module-level interval (via `createPolledResource`)
 * drives every subscriber — replaces N independent `setInterval`s across all
 * `useElapsed` call sites. Component re-renders happen in the same React batch
 * (React 18+ auto-batching). The "fetch" is a synchronous `Date.now()` tick.
 */
const resource = createPolledResource<number>({
  fetcher: () => Date.now(),
  intervalMs: 1_000,
  initial: Date.now(),
});

export function useNow(): number {
  return resource.useResource();
}
