import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("dashboard responses never grant wildcard CORS", () => {
  for (const path of [
    "src/tracker/dashboard/hono/responses.ts",
    "src/tracker/dashboard/hono/sse.ts",
    "src/tracker/dashboard/hono/app.ts",
  ]) {
    assert.equal(
      source(path).includes('"Access-Control-Allow-Origin": "*"'),
      false,
      `${path} must leave CORS to the strict request boundary`,
    );
  }
});

test("operator authentication middleware is registered before dashboard routes", () => {
  const app = source("src/tracker/dashboard/hono/app.ts");
  const middleware = app.indexOf("dashboardAccessMiddleware(deps.accessPolicy)");
  const firstRouteFamily = app.indexOf("registerProjectionRoutes(app, deps)");
  assert.ok(middleware >= 0, "dashboard access middleware must be registered");
  assert.ok(firstRouteFamily > middleware, "access middleware must precede every route family");
  assert.match(app, /createPublicCaptureHonoApp[\s\S]+registerCaptureRoutes\(app, deps\)/);
  assert.equal(
    /createPublicCaptureHonoApp[\s\S]+register(?:Ops|Ocr|Settings|File|Hub)Routes\(/.test(app),
    false,
    "public Capture app must not register dashboard route families",
  );
});

test("real dashboard servers bind explicitly and receive an access policy", () => {
  const server = source("src/tracker/dashboard/server.ts");
  assert.match(server, /createDashboardAccessPolicy\(/);
  assert.match(server, /createDashboardHonoApp\(\{ \.\.\.sharedDeps, accessPolicy \}\)/);
  assert.match(server, /localServer\.listen\(port, host,/);
  assert.match(server, /createPublicCaptureHonoApp\(sharedDeps\)/);
});
