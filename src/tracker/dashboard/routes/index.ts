import type { IncomingMessage, ServerResponse } from "node:http";
import { writeCorsPreflight } from "../http.js";
import type { DashboardRoute, DashboardRouteContext } from "../route-types.js";

export function createDashboardRequestListener(
  ctx: DashboardRouteContext,
  routes: DashboardRoute[],
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${ctx.port}`);

    if (req.method === "OPTIONS") {
      writeCorsPreflight(res);
      return;
    }

    for (const route of routes) {
      const handled = await route(req, res, url, ctx);
      if (handled || res.headersSent || res.writableEnded) return;
    }

    res.writeHead(404);
    res.end();
  };
}
