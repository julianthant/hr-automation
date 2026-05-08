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
      try {
        const env = JSON.parse(ev.data) as { sub: string; data: unknown; event?: string };
        this.subs.get(env.sub)?.listener(env.data, env.event);
      } catch {
        // malformed envelope — ignore
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
