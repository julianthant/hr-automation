import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";

import type { DashboardRoute } from "../route-types.js";

function isHonoPhase1Path(pathname: string): boolean {
  return pathname.startsWith("/api/v2/") || pathname.startsWith("/api/files/");
}

export function createHonoDashboardRoute(app: Hono): DashboardRoute {
  const listener = getRequestListener(app.fetch);
  return async (req, res, url) => {
    if (!isHonoPhase1Path(url.pathname)) return false;
    await listener(req, res);
    return true;
  };
}
