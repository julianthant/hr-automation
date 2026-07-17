import { activeCaptureSseSubscribers as activeCaptureSseSubscribersBinding } from "./topics-emitters.js";

export type SseSend = (data: unknown, event?: string) => void;
export type SseCleanup = () => void | Promise<void>;

let activeHonoSseStreams = 0;

export function getActiveHonoSseStreamCountForTests(): number {
  return activeHonoSseStreams;
}

export function getActiveHonoCaptureSseSubscriberCountForTests(): number {
  return activeCaptureSseSubscribersBinding;
}

/**
 * A slow client is disconnected once this many messages sit unread in the
 * stream buffer (default chunk-counting strategy: desiredSize = 1 − buffered).
 * Buffering payloads indefinitely for a stalled consumer grows process memory
 * with the full queue snapshot per tick; EventSource reconnects automatically
 * and the fresh subscription starts from a first-tick full payload.
 */
const SSE_MAX_BUFFERED_MESSAGES = 512;

/** Comment ping cadence — keeps proxies (vite dev, ngrok) from reaping streams
 *  that go quiet under change-gated topics. EventSource ignores comments. */
const SSE_KEEPALIVE_MS = 30_000;

export function sseResponse(
  start: (send: SseSend) => SseCleanup | void | Promise<SseCleanup | void>,
  request?: Request,
): Response {
  const encoder = new TextEncoder();
  let cleanup: SseCleanup | undefined;
  let cleaned = false;
  let keepAlive: NodeJS.Timeout | undefined;

  const runCleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (keepAlive) clearInterval(keepAlive);
    activeHonoSseStreams = Math.max(0, activeHonoSseStreams - 1);
    try {
      void cleanup?.();
    } catch {
      /* tolerate cleanup failures during aborted streams */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      activeHonoSseStreams += 1;

      // Defensive cleanup on HTTP disconnect. request.signal fires "abort"
      // when the underlying TCP socket closes in @hono/node-server + Node 26.
      // This is a safety net: the ReadableStream cancel() callback should also
      // fire, but this covers cases where the pipe teardown doesn't propagate.
      if (request?.signal) {
        request.signal.addEventListener("abort", () => runCleanup(), { once: true });
      }

      const send: SseSend = (data, event) => {
        if (cleaned) return;
        // Backpressure: a consumer that stopped reading gets disconnected
        // instead of buffering snapshots without bound.
        if (
          controller.desiredSize !== null &&
          controller.desiredSize <= 1 - SSE_MAX_BUFFERED_MESSAGES
        ) {
          runCleanup();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }
        const payload = `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          runCleanup();
        }
      };

      keepAlive = setInterval(() => {
        if (cleaned) return;
        try {
          controller.enqueue(encoder.encode(":ka\n\n"));
        } catch {
          runCleanup();
        }
      }, SSE_KEEPALIVE_MS);
      keepAlive.unref?.();

      try {
        cleanup = (await start(send)) ?? undefined;
        // The stream can be torn down (slow-client kick, abort) while start()
        // is still resolving — run the late-registered cleanup immediately so
        // its topic intervals don't leak.
        if (cleaned) {
          try {
            void cleanup?.();
          } catch {
            /* tolerate cleanup failures on an already-dead stream */
          }
        }
      } catch (err) {
        send({ ok: false, error: err instanceof Error ? err.message : String(err) });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        runCleanup();
      }
    },
    cancel() {
      runCleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
