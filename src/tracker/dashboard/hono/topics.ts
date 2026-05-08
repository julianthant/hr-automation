import type { DashboardHonoDeps } from "./context.js";

// ── Topic emitter contract ────────────────────────────────────────────────────

/**
 * Callback the emitter uses to push data to the client.
 * `event` is an optional per-subscription event name (used e.g. by the
 * capture-sessions topic to distinguish session-list vs session-event vs
 * heartbeat messages).  The hub encodes it inside the `HubEnvelope.event`
 * field — NOT as an SSE-protocol `event:` line.
 */
export type TopicSend = (data: unknown, event?: string) => void;

/**
 * Return value of a `TopicEmitter`.  Call it to tear down any intervals,
 * watchers, or store subscriptions the emitter started.
 */
export type TopicStop = () => void | Promise<void>;

/**
 * A topic emitter wires up one SSE subscription.  It receives topic-specific
 * `params`, a `send` callback to push messages, and the dashboard deps.
 * It MUST return a `TopicStop` that cleans up any resources it owns.
 */
export type TopicEmitter<P = unknown> = (
  params: P,
  send: TopicSend,
  deps: DashboardHonoDeps,
) => TopicStop;

// ── Wire-format types ─────────────────────────────────────────────────────────

/** One entry in the `subs` query-param array sent by the client. */
export interface Subscription {
  id: string;
  topic: string;
  params: unknown;
}

/**
 * Each SSE `data:` line the hub sends wraps the emitter's payload in this
 * envelope so the client can demux by subscription id.
 */
export interface HubEnvelope {
  sub: string;
  data: unknown;
  event?: string;
}

// ── Topic registry ────────────────────────────────────────────────────────────

export const topicRegistry = new Map<string, TopicEmitter<unknown>>();

export function registerTopic<P>(name: string, emitter: TopicEmitter<P>): void {
  topicRegistry.set(name, emitter as TopicEmitter<unknown>);
}

// ── Query-param parser ────────────────────────────────────────────────────────

/**
 * Decode and validate the `subs` query parameter.
 *
 * Returns a `Subscription[]` on success, or `{ error: string }` on any
 * validation failure:
 * - `raw` is `undefined` or not valid JSON
 * - parsed value is not an array
 * - any element is missing a string `id` or string `topic`
 * - two elements share the same `id`
 */
export function parseSubsQuery(
  raw: string | undefined,
): Subscription[] | { error: string } {
  if (raw === undefined || raw === "") {
    return { error: "subs query param is required" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "subs is not valid JSON" };
  }

  if (!Array.isArray(parsed)) {
    return { error: "subs must be a JSON array" };
  }

  const subs: Subscription[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (item === null || typeof item !== "object") {
      return { error: `subs[${i}] must be an object` };
    }

    const { id, topic, params } = item as Record<string, unknown>;

    if (typeof id !== "string" || id === "") {
      return { error: `subs[${i}].id must be a non-empty string` };
    }
    if (typeof topic !== "string" || topic === "") {
      return { error: `subs[${i}].topic must be a non-empty string` };
    }
    if (seenIds.has(id)) {
      return { error: `duplicate subscription id: ${id}` };
    }

    seenIds.add(id);
    subs.push({ id, topic, params: params ?? {} });
  }

  return subs;
}
