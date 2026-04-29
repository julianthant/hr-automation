import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Subscribe to /events/telegram and fire a sonner toast for each new
 * `telegram_sent` session event.
 *
 * Reconnect-safe semantics. The backend's SSE handler keeps per-connection
 * state (`firstTick` + `sentCount`) — so when EventSource auto-reconnects
 * after a network blip or sleep+wake the backend re-sends the full
 * history as if it were the first tick. The frontend would otherwise see
 * those historical events as deltas and re-toast every Duo prompt the
 * operator already saw. Two layers of defence:
 *
 *   1. `initializedRef` — distinguishes the first tick of THIS hook's
 *      lifetime (intentional history; never toast) from subsequent ticks
 *      (potentially live).
 *   2. `lastSeenTsRef` — monotonic high-water mark across ALL ticks. Any
 *      event with `ts <= lastSeenTs` is skipped, even if a reconnect
 *      replays the snapshot. Initial load primes lastSeenTs from the
 *      snapshot's tail, so live ticks naturally drop history.
 *
 * The watermark is timestamp-only — no event-id field exists in the
 * tracker, but events are written by `appendFileSync` in monotonic order
 * within a single process. Cross-process clock skew on shared filesystems
 * is not a concern here (single dashboard instance per machine).
 */
export function useTelegramToasts(): void {
  const initializedRef = useRef(false);
  const lastSeenTsRef = useRef<string>("");

  useEffect(() => {
    const es = new EventSource("/events/telegram");

    es.onmessage = (e) => {
      let events: TelegramSentEvent[] = [];
      try {
        events = JSON.parse(e.data);
      } catch {
        return;
      }
      // First tick of THIS hook lifetime — history replay. Prime the
      // watermark and stay silent. (Backend's first-tick batch is the
      // entire history; events arrive in chronological order, so the
      // last entry is the latest.)
      if (!initializedRef.current) {
        initializedRef.current = true;
        if (events.length > 0) {
          lastSeenTsRef.current = events[events.length - 1].timestamp;
        }
        return;
      }
      // Subsequent ticks. Could be a real delta OR a reconnect snapshot
      // replay; the watermark filter handles both uniformly.
      for (const ev of events) {
        if (!ev.timestamp || ev.timestamp <= lastSeenTsRef.current) continue;
        const kind = ev.data?.kind ?? "duo-waiting";
        const systemLabel = ev.data?.systemLabel ?? "auth";
        const workflow = ev.data?.workflow ?? "";
        const ICONS: Record<string, string> = {
          "duo-waiting": "🔐",
          "duo-approved": "✅",
          "duo-timeout": "⌛",
          "duo-resent": "🔄",
        };
        const TITLES: Record<string, string> = {
          "duo-waiting": "Duo prompt sent to phone",
          "duo-approved": "Duo approved",
          "duo-timeout": "Duo timed out",
          "duo-resent": "Duo push resent",
        };
        const fn = kind === "duo-timeout" ? toast.error : kind === "duo-approved" ? toast.success : toast.info;
        fn(`${ICONS[kind] ?? "📨"} ${TITLES[kind] ?? "Telegram sent"}`, {
          description: workflow ? `${systemLabel} · ${workflow}` : systemLabel,
        });
        lastSeenTsRef.current = ev.timestamp;
      }
    };

    es.onerror = () => {
      // Sonner reconnect notifications are noisy for an aux channel;
      // the EventSource browser default is to retry automatically.
    };

    return () => {
      es.close();
    };
  }, []);
}

interface TelegramSentEvent {
  type: "telegram_sent";
  timestamp: string;
  data?: {
    kind?: string;
    systemLabel?: string;
    workflow?: string;
    detail?: string;
  };
}
