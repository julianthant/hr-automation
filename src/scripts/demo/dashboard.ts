import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { createDashboardHonoApp } from "../../tracker/dashboard/hono/app.js";
import { emitTrackerRow, dateLocal } from "../../tracker/jsonl-io.js";
import { openStateDb } from "../../tracker/state/db.js";
import { rebuildProjectionForAllDates } from "../../tracker/state/rebuild.js";
import { parseSubsQuery } from "../../tracker/dashboard/hono/topics.js";
import { isMainModule } from "../main-module.js";
import { log } from "../../utils/log.js";

const READ_PATHS = new Set([
  "/", "/index.html", "/favicon.svg", "/events/hub",
  "/api/workflows", "/api/workflow-definitions", "/api/dates",
  "/api/entries", "/api/entry-data", "/api/logs", "/api/runs",
  "/api/v2/entries", "/api/v2/runs", "/api/v2/projection/health",
]);

const DEMO_PARAMS = z.object({
  workflow: z.literal("person-lookup").optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).passthrough();

/** Uses the production renderer with fresh synthetic state and read routes only. */
export function createDemoDashboard(dir: string, staticDir: string): Hono {
  const db = openStateDb(dir);
  const timestamp = new Date().toISOString();
  for (const [index, status] of (["done", "failed", "pending"] as const).entries()) {
    emitTrackerRow({
      workflow: "person-lookup", timestamp, id: `9000000${index + 1}`,
      runId: `synthetic-demo-${index + 1}`, status,
      data: {
        archetype: "single", queueRowKind: "person",
        name: ["Example, Avery", "Example, Blair", "Example, Casey"][index],
        emplId: `9000000${index + 1}`, __traceId: `pl-120000-demo${index + 1}`,
        ...(status === "failed" ? { error: "Synthetic failure for dashboard preview" } : {}),
      },
    }, dir);
  }
  rebuildProjectionForAllDates(db, { dir, includeDates: [dateLocal()] });
  const dashboard = createDashboardHonoApp({
    dir, stateDb: db, staticDir, repoRoot: dir,
    workflow: "person-lookup", projectionReady: true,
  });
  const app = new Hono();
  app.all("*", (c) => {
    if (c.req.method !== "GET" || !READ_PATHS.has(c.req.path)) {
      return c.json({ ok: false, error: "Mock preview is read-only. Live workflows are disabled." }, 403);
    }
    if (!DEMO_PARAMS.safeParse(c.req.query()).success) {
      return c.json({ ok: false, error: "Mock preview accepts synthetic workflow and date queries only." }, 403);
    }
    if (c.req.path === "/events/hub") {
      const subs = parseSubsQuery(c.req.query("subs"));
      if ("error" in subs || subs.some((sub) =>
        !["entries", "sessions", "captureSessions", "logs", "runEvents"].includes(sub.topic) ||
        !DEMO_PARAMS.safeParse(sub.params).success)) {
        return c.json({ ok: false, error: "Mock preview accepts synthetic subscriptions only." }, 403);
      }
    }
    if (c.req.path === "/" && !c.req.query("wf")) {
      return c.redirect("/?wf=person-lookup");
    }
    return dashboard.fetch(c.req.raw);
  });
  return app;
}

if (isMainModule(import.meta.url)) {
  const dir = mkdtempSync(join(tmpdir(), "hr-automation-demo-"));
  const app = createDemoDashboard(dir, resolve("dist/dashboard"));
  const server = createServer(getRequestListener(app.fetch));
  server.on("error", (error) => { log.error(error.message); process.exitCode = 1; });
  server.listen(3939, "127.0.0.1", () => {
    log.step("Read-only mock dashboard: http://127.0.0.1:3939 — synthetic data, no workflow starts");
  });
}
