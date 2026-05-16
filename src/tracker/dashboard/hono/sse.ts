export type SseSend = (data: unknown, event?: string) => void;
export type SseCleanup = () => void | Promise<void>;

let activeHonoSseStreams = 0;

export function getActiveHonoSseStreamCountForTests(): number {
  return activeHonoSseStreams;
}

export function sseResponse(
  start: (send: SseSend) => SseCleanup | void | Promise<SseCleanup | void>,
  request?: Request,
): Response {
  const encoder = new TextEncoder();
  let cleanup: SseCleanup | undefined;
  let cleaned = false;

  const runCleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
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
        const payload = `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          runCleanup();
        }
      };

      try {
        cleanup = (await start(send)) ?? undefined;
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
      "Access-Control-Allow-Origin": "*",
    },
  });
}
