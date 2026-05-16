import type { Hono } from "hono";

import { log } from "../../../../utils/log.js";
import type { DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";
import { sseResponse } from "../sse.js";
import { parseSubsQuery, topicRegistry, type TopicStop } from "../topics.js";
// Side-effect import: registers all topic emitters into topicRegistry.
import "../topics-emitters.js";

export function registerHubRoute(app: Hono, deps: DashboardHonoDeps): void {
  app.get("/events/hub", (c) => {
    const raw = c.req.query("subs");
    const result = parseSubsQuery(raw);

    if ("error" in result) {
      return jsonResponse({ ok: false, error: result.error }, 400);
    }

    const subs = result;

    return sseResponse((send) => {
      const stops: TopicStop[] = [];

      for (const sub of subs) {
        const emitter = topicRegistry.get(sub.topic);
        if (!emitter) {
          log.warn(`SSE hub: unknown topic "${sub.topic}" for sub "${sub.id}" — skipping`);
          continue;
        }

        // Wrap the emitter's send so every payload is enveloped with the
        // subscription id.  The optional `event` field is passed through
        // inside the envelope (NOT as an SSE-protocol event: line).
        const subSend = (data: unknown, event?: string) => {
          const envelope = {
            sub: sub.id,
            data,
            ...(event !== undefined ? { event } : {}),
          };
          send(envelope);
        };

        const stop = emitter(sub.params, subSend, deps);
        stops.push(stop);
      }

      // Cleanup: stop all topic emitters when the client disconnects.
      return async () => {
        await Promise.allSettled(stops.map((s) => s()));
      };
    }, c.req.raw);
  });
}
