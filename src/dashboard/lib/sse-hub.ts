type Listener = (data: unknown, event?: string) => void;
type ErrorHandler = () => void;

interface Sub {
  id: string;
  topic: string;
  params: unknown;
  listener: Listener;
  onError?: ErrorHandler;
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
    const url = `/events/hub?subs=${encodeURIComponent(JSON.stringify(subsArray))}`;
    const es = new EventSource(url);
    es.onmessage = (ev) => {
      let env: { sub: string; data: unknown; event?: string };
      try {
        env = JSON.parse(ev.data) as { sub: string; data: unknown; event?: string };
      } catch {
        // malformed envelope — ignore
        console.warn("SseHub: malformed envelope (could not parse JSON), ignoring.");
        return;
      }
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
      // Browser EventSource auto-reconnects; we do not manually rebuild on error.
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
