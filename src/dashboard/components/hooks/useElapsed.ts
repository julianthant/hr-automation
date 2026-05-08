import { useNow } from "./useNow.js";

/** Returns a live "Xm Ys" string that counts up from startTime. */
export function useElapsed(startTime: string | null): string {
  const now = useNow();
  if (!startTime) return "";
  const start = new Date(startTime).getTime();
  const diff = Math.max(0, Math.floor((now - start) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Format a duration in seconds to "Xm Ys" (static, no hook). */
export function formatDuration(startIso: string, endIso: string): string {
  const diff = Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
