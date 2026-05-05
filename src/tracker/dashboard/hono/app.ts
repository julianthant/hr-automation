import { createReadStream, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

import { getRegisteredFile } from "../../files.js";
import { getCachedPage } from "../../pdf-cache.js";
import { queryEntriesPayload, queryProjectionHealth, queryRunsForItem } from "../../state/queries.js";

export interface DashboardHonoDeps {
  dir: string;
  stateDb: Database.Database;
}

export function createDashboardHonoApp(deps: DashboardHonoDeps): Hono {
  const app = new Hono();

  app.get("/api/v2/projection/health", (c) => {
    return c.json(queryProjectionHealth(deps.stateDb, deps.dir));
  });

  app.get("/api/v2/entries", (c) => {
    const workflow = c.req.query("workflow") ?? "onboarding";
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    return c.json(queryEntriesPayload(deps.stateDb, { workflow, date }));
  });

  app.get("/api/v2/runs", (c) => {
    const workflow = c.req.query("workflow") ?? "";
    const itemId = c.req.query("id") ?? "";
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    if (!workflow || !itemId) {
      return c.json({ ok: false, error: "workflow and id are required" }, 400);
    }
    return c.json(queryRunsForItem(deps.stateDb, { workflow, itemId, date }));
  });

  app.get("/api/files/:fileId/download", (c) => {
    const file = getRegisteredFile(deps.stateDb, c.req.param("fileId"));
    if (!file || !existsSync(file.storagePath)) return c.text("not found", 404);
    const stat = statSync(file.storagePath);
    return new Response(createReadStream(file.storagePath) as unknown as BodyInit, {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${basename(file.originalName).replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  app.get("/api/files/:fileId/original", (c) => {
    const file = getRegisteredFile(deps.stateDb, c.req.param("fileId"));
    if (!file || !existsSync(file.storagePath)) return c.text("not found", 404);
    const stat = statSync(file.storagePath);
    return new Response(createReadStream(file.storagePath) as unknown as BodyInit, {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(stat.size),
        "Cache-Control": "no-store",
      },
    });
  });

  app.get("/api/files/:fileId/pages/:page", (c) => {
    const page = Number(c.req.param("page"));
    const cached = getCachedPage(deps.stateDb, c.req.param("fileId"), page);
    if (!cached || cached.status !== "ready" || !cached.imagePath || !existsSync(cached.imagePath)) {
      return c.text("not found", 404);
    }
    const stat = statSync(cached.imagePath);
    return new Response(createReadStream(cached.imagePath) as unknown as BodyInit, {
      headers: {
        "Content-Type": cached.mimeType ?? "image/png",
        "Content-Length": String(stat.size),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  return app;
}
