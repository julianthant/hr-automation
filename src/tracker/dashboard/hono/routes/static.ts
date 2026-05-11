import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";

import type { DashboardHonoDeps } from "../context.js";
import { streamFileResponse, textResponse } from "../responses.js";

const RESERVED_PREFIXES = [
  "/api",
  "/events",
  "/capture",
  "/capture-assets",
  "/screenshots",
];

export function registerStaticRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.get("/", () => serveIndex(deps));
  app.get("/index.html", () => serveIndex(deps));
  app.get("*", (c) => {
    const path = new URL(c.req.url).pathname;
    if (RESERVED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return textResponse("not found", 404);
    }
    return serveIndex(deps);
  });
}

async function serveIndex(deps: DashboardHonoDeps): Promise<Response> {
  if (!deps.staticDir) return textResponse("not found", 404);
  const indexPath = join(deps.staticDir, "index.html");
  if (!existsSync(indexPath)) return textResponse("dashboard build not found", 404);
  return await streamFileResponse(indexPath, {
    contentType: "text/html; charset=utf-8",
    cacheControl: "no-cache",
  });
}
