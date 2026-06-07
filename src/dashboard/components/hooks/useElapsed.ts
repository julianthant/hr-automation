import { useNow } from "./useNow.js";

/**
 * Format a whole-second count into a compact, scannable label.
 *   <1h  → "Xm SSs"  (keep mm:ss precision where it's useful — short runs)
 *   <24h → "Xh Mm"   (roll up so long runs stay readable: 146m → "2h 27m")
 *   else → "Xd Hh"   (8176m → "5d 16h")
 * Matches `formatStepDuration`'s 1h rollover so footer + step timings agree.
 */
export function formatSeconds(diff: number): string {
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    const s = diff % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Returns a live, rolled-up duration string that counts up from startTime. */
export function useElapsed(startTime: string | null): string {
  const now = useNow();
  if (!startTime) return "";
  const start = new Date(startTime).getTime();
  const diff = Math.max(0, Math.floor((now - start) / 1000));
  return formatSeconds(diff);
}

/** Format a duration between two ISO timestamps (static, no hook). */
export function formatDuration(startIso: string, endIso: string): string {
  const diff = Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  return formatSeconds(diff);
}
