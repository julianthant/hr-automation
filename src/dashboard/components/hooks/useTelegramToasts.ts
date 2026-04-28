import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Subscribe to /events/telegram and fire a sonner toast for each new
 * `telegram_sent` session event.
 *
 * Delta semantics: the SSE backend replays the full history on first
 * tick (so a refresh of the dashboard doesn't dump every Telegram
 * message ever sent), but the hook deliberately tags the first tick
 * with `firstTickRef` so we DON'T toast historical events on mount.
 * Only events that arrive AFTER the first message become toasts —
 * matches "live event stream" semantics rather than "replay log".
 */
export function useTelegramToasts(): void {
  const firstTickRef = useRef(true);

  useEffect(() => {
    const es = new EventSource("/events/telegram");

    es.onmessage = (e) => {
      let events: TelegramSentEvent[] = [];
      try {
        events = JSON.parse(e.data);
      } catch {
        return;
      }
      if (firstTickRef.current) {
        // Backend replays history on connect — discard so a dashboard
        // refresh doesn't avalanche toasts.
        firstTickRef.current = false;
        return;
      }
      for (const ev of events) {
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
