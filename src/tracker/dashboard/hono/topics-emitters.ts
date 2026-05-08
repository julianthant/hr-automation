import { readSessionEvents } from "../../../tracker/session-events.js";
import { registerTopic, type TopicEmitter } from "./topics.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

async function readSessionEventsTolerant(dir: string) {
  try {
    return readSessionEvents(dir);
  } catch {
    // Transient read failures recover on the next tick.
    return [];
  }
}

// ── telegram topic ────────────────────────────────────────────────────────────

/**
 * Polls `sessions.jsonl` every 1 second and sends delta batches of
 * `telegram_sent` events.  Emits the full list on first tick, then only
 * new events on subsequent ticks.
 *
 * Identical behavior to the legacy `/events/telegram` handler.
 */
export const telegramTopic: TopicEmitter<Record<string, never>> = (
  _params,
  send,
  deps,
) => {
  let sentCount = 0;
  let firstTick = true;

  const tick = async () => {
    const events = (await readSessionEventsTolerant(deps.dir)).filter(
      (event) => event.type === "telegram_sent",
    );
    if (firstTick) {
      send(events);
      sentCount = events.length;
      firstTick = false;
    } else if (events.length > sentCount) {
      send(events.slice(sentCount));
      sentCount = events.length;
    }
  };

  void tick();
  const interval = setInterval(() => void tick(), 1_000);
  interval.unref?.();
  return () => clearInterval(interval);
};

registerTopic("telegram", telegramTopic);
