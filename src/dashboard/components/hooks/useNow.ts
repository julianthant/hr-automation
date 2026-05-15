import { useEffect, useState } from "react";

let now = Date.now();
const subscribers = new Set<(n: number) => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  now = Date.now();
  for (const sub of subscribers) sub(now);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    subscribers.clear();
  });
}

/**
 * Subscribe to a shared 1Hz clock. One module-level setInterval drives
 * all subscribers — replaces N independent setIntervals across all
 * useElapsed call sites. Component re-renders happen in the same React
 * batch (React 18+ auto-batching).
 */
export function useNow(): number {
  const [n, setN] = useState(now);
  useEffect(() => {
    subscribers.add(setN);
    if (subscribers.size === 1) intervalId = setInterval(tick, 1000);
    return () => {
      subscribers.delete(setN);
      if (subscribers.size === 0 && intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
  }, []);
  return n;
}
