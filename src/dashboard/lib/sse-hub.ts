type Listener = (data: unknown, event?: string) => void;
type ErrorHandler = () => void;

/**
 * Multiplexes dashboard SSE topics over one EventSource. Subscription changes
 * intentionally rebuild the connection instead of sending subscribe deltas:
 * the backend's first tick for every topic is a full history snapshot, and
 * consumers reset their first-tick guards in `onError`, so reconnect replay
 * replaces local history rather than appending duplicate rows.
 */

interface Sub {
  id: string;
  topic: string;
  params: unknown;
  listener: Listener;
  onError?: ErrorHandler;
}

function payloadPreview(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return String(value);
    return json.length > 500 ? `${json.slice(0, 500)}...` : json;
  } catch {
    return String(value);
  }
}

function isHubEnvelope(value: unknown): value is { sub: string; data: unknown; event?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return (
    typeof envelope.sub === "string" &&
    "data" in envelope &&
    (envelope.event === undefined || typeof envelope.event === "string")
  );
}

function buildHubUrl(subsArray: Array<{ id: string; topic: string; params: unknown }>): string {
  const path = `/events/hub?subs=${encodeURIComponent(JSON.stringify(subsArray))}`;
  if (typeof window !== "undefined" && window.location.port === "5173") {
    return `${window.location.protocol}//${window.location.hostname}:3838${path}`;
  }
  return path;
}

export class SseHub {
  private es: EventSource | null = null;
  private subs = new Map<string, Sub>();
  private nextId = 0;
  private rebuildScheduled = false;

  subscribe<T>(
    topic: string,
    params: unknown,
    listener: (data: T, event?: string) => void,
    onError?: ErrorHandler,
  ): () => void {
    const id = `s${++this.nextId}`;
    this.subs.set(id, { id, topic, params, listener: listener as Listener, onError });
    this.scheduleRebuild();
    return () => {
      this.subs.delete(id);
      this.scheduleRebuild();
    };
  }

  private scheduleRebuild(): void {
    if (this.rebuildScheduled) return;
    this.rebuildScheduled = true;
    queueMicrotask(() => {
      this.rebuildScheduled = false;
      this.rebuild();
    });
  }

  private rebuild(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    if (this.subs.size === 0) return;
    const subsArray = [...this.subs.values()].map(({ id, topic, params }) => ({ id, topic, params }));
    const url = buildHubUrl(subsArray);
    const es = new EventSource(url);
    es.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data as string) as unknown;
      } catch {
        // malformed envelope — ignore
        console.warn("SseHub: malformed envelope (could not parse JSON), ignoring.");
        return;
      }
      if (!isHubEnvelope(parsed)) {
        console.warn(`SseHub: malformed envelope shape, ignoring payload=${payloadPreview(parsed)}`);
        return;
      }
      const env = parsed;
      const sub = this.subs.get(env.sub);
      if (!sub) return;
      try {
        sub.listener(env.data, env.event);
      } catch (err) {
        console.error(`SseHub listener threw for topic '${sub.topic}':`, err);
        // Do NOT crash the connection — other listeners still need delivery.
      }
    };
    es.onerror = () => {
      for (const sub of this.subs.values()) sub.onError?.();
      if (es.readyState === EventSource.CLOSED) {
        // The browser gave up entirely; rebuild through the normal batched path.
        this.scheduleRebuild();
      }
    };
    this.es = es;
  }

  /**
   * @internal Test-only. Resets hub state so tests can start with a clean instance.
   * Do not call in production code.
   */
  __resetForTests(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.subs.clear();
    this.nextId = 0;
    this.rebuildScheduled = false;
  }
}

export const sseHub = new SseHub();
