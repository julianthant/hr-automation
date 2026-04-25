import { useEffect, useState } from "react";

export interface DaemonInfo {
  workflow: string;
  pid: number;
  port: number;
  instanceId: string;
  startedAt: string;
  uptimeMs: number;
  itemsProcessed: number;
  currentItem: string | null;
  phase: string;
}

/**
 * Polls /api/daemons every 5s. The list is small (typically 0–4 daemons
 * total across all workflows) so a 5s poll cadence is plenty responsive
 * for "did my spawn just come online" without burning network. Expose a
 * `refresh()` so post-action callbacks (spawn/stop) can re-poll
 * immediately rather than wait for the next tick.
 */
export function useDaemons(): { daemons: DaemonInfo[]; refresh: () => void } {
  const [daemons, setDaemons] = useState<DaemonInfo[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchDaemons = async (): Promise<void> => {
      try {
        const res = await fetch("/api/daemons");
        if (!res.ok) return;
        const body = (await res.json()) as DaemonInfo[];
        if (!cancelled) setDaemons(body);
      } catch {
        /* swallow */
      }
    };
    void fetchDaemons();
    const interval = setInterval(fetchDaemons, 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tick]);

  return { daemons, refresh: () => setTick((t) => t + 1) };
}

/** Format a ms duration as a short uptime string ("3m 12s", "1h 04m"). */
export function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
