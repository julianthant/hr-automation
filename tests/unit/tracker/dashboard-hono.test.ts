import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import { openStateDb, closeStateDbForTests, stateDbPath, runMigrations } from "../../../src/tracker/state/db.js";
import { openDatabase } from "../../../src/infra/sqlite/index.js";
import { applyTrackerEntry } from "../../../src/tracker/state/apply.js";
import { queryProjectionHealth } from "../../../src/tracker/state/queries.js";
import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { __resetPreflightThrottleForTests } from "../../../src/tracker/dashboard/hono/routes/base.js";
import { registerLocalFile } from "../../../src/tracker/files/files.js";
import { trackEventForDate, trackEvent, emitScreenshotEvent, dateLocal } from "../../../src/tracker/jsonl.js";
import { rowFilePath, rowsDir } from "../../../src/tracker/paths.js";
import { clear, register } from "../../../src/core/kernel/registry.js";
import { defineWorkflow } from "../../../src/core/kernel/workflow.js";
import { defaultPresentationFromMetadata } from "../../../src/domain/workflow-presentation/resolve.js";

test("Hono /api/v2/projection/health returns projection metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-state-"));
  try {
    const db = openStateDb(dir);
    const app = createDashboardHonoApp({ dir, stateDb: db });
    const res = await app.request("/api/v2/projection/health");
    assert.equal(res.status, 200);
    const body = await res.json() as ReturnType<typeof queryProjectionHealth>;
    assert.equal(body.ok, true);
    assert.equal(body.dbPath.endsWith("state.db"), true);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono projection routes reopen state.db when the file was replaced after server start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-state-replaced-"));
  const date = "2026-05-24";
  let replacementDb: ReturnType<typeof openDatabase> | undefined;
  try {
    const staleDb = openStateDb(dir);
    const app = createDashboardHonoApp({
      dir,
      stateDb: staleDb,
      workflow: "oath-signature",
      projectionReady: true,
    });

    rmSync(stateDbPath(dir), { force: true });
    rmSync(`${stateDbPath(dir)}-wal`, { force: true });
    rmSync(`${stateDbPath(dir)}-shm`, { force: true });

    replacementDb = openDatabase(stateDbPath(dir));
    runMigrations(replacementDb);
    applyTrackerEntry(
      replacementDb,
      {
        workflow: "oath-signature",
        timestamp: "2026-05-24T20:18:41.326Z",
        id: "ocr-prep-session-1",
        runId: "prep-run-1",
        status: "pending",
        data: { archetype: "operation", mode: "prepare" },
      },
      {
        sourceKind: "tracker",
        workflow: "oath-signature",
        trackerDate: date,
        path: rowFilePath("oath-signature", date, dir),
        line: 1,
        offset: 0,
      },
    );

    const res = await app.request(`/api/v2/entries?workflow=oath-signature&date=${date}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { entries: Array<{ id: string }> };
    assert.deepEqual(body.entries.map((entry) => entry.id), ["ocr-prep-session-1"]);
  } finally {
    replacementDb?.close();
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono app returns 404 for unknown dashboard paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-404-"));
  try {
    const db = openStateDb(dir);
    const app = createDashboardHonoApp({ dir, stateDb: db });
    const res = await app.request("/api/definitely-not-a-dashboard-route");
    assert.equal(res.status, 404);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono OPTIONS for migrated routes returns dashboard CORS preflight shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-options-"));
  try {
    const db = openStateDb(dir);
    const app = createDashboardHonoApp({ dir, stateDb: db });
    const res = await app.request("/api/workflow-definitions", { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono /api/workflow-definitions returns registered workflow metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-workflows-"));
  try {
    clear();
    defineWorkflow({
      name: "wf-hono",
      systems: [{ id: "ucpath", login: async () => {} }],
      authSteps: false,
      steps: ["extract", "submit"] as const,
      schema: z.object({}),
      detailFields: [],
      handler: async () => {},
    });
    register({
      name: "legacy-hono",
      label: "Legacy Hono",
      systems: ["crm"],
      steps: ["one"],
      archetype: "single",
      code: "lh",
      detailFields: [],
      presentation: defaultPresentationFromMetadata({ archetype: "single" }),
    });
    const db = openStateDb(dir);
    const app = createDashboardHonoApp({ dir, stateDb: db });
    const res = await app.request("/api/workflow-definitions");
    assert.equal(res.status, 200);
    const body = await res.json() as Array<{ name: string; steps: string[] }>;
    assert.ok(body.some((workflow) => workflow.name === "wf-hono" && workflow.steps.includes("submit")));
    assert.ok(body.some((workflow) => workflow.name === "legacy-hono"));
  } finally {
    clear();
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono /api/runs uses SQLite projection when ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-runs-sqlite-"));
  const date = "2026-05-04";
  try {
    const db = openStateDb(dir);
    trackEventForDate({
      workflow: "onboarding",
      timestamp: "2026-05-04T12:00:00.000Z",
      id: "jane@ucsd.edu",
      runId: "jane-run-1",
      status: "pending",
      data: { email: "jane@ucsd.edu" },
    }, date, dir);
    trackEventForDate({
      workflow: "onboarding",
      timestamp: "2026-05-04T12:01:00.000Z",
      id: "jane@ucsd.edu",
      runId: "jane-run-1",
      status: "done",
      step: "transaction",
      data: { email: "jane@ucsd.edu" },
    }, date, dir);
    const app = createDashboardHonoApp({ dir, stateDb: db, workflow: "onboarding", projectionReady: true });
    const res = await app.request(`/api/runs?workflow=onboarding&id=${encodeURIComponent("jane@ucsd.edu")}&date=${date}`);
    assert.equal(res.status, 200);
    const body = await res.json() as Array<{ runId: string; status: string; step?: string; runOrdinal?: number }>;
    assert.deepEqual(body.map((run) => ({
      runId: run.runId,
      status: run.status,
      step: run.step,
      runOrdinal: run.runOrdinal,
    })), [{ runId: "jane-run-1", status: "done", step: "transaction", runOrdinal: 1 }]);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono /api/runs falls back to JSONL when projection is not ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-runs-jsonl-"));
  const date = "2026-05-04";
  try {
    const db = openStateDb(dir);
    mkdirSync(rowsDir(dir), { recursive: true });
    writeFileSync(rowFilePath("onboarding", date, dir), [
      JSON.stringify({
        workflow: "onboarding",
        timestamp: "2026-05-04T12:00:00.000Z",
        id: "jane@ucsd.edu",
        runId: "jane@ucsd.edu#1",
        status: "running",
        step: "extraction",
        data: { email: "jane@ucsd.edu" },
      }),
      JSON.stringify({
        workflow: "onboarding",
        timestamp: "2026-05-04T12:02:00.000Z",
        id: "jane@ucsd.edu",
        runId: "jane@ucsd.edu#1",
        status: "done",
        step: "transaction",
        data: { email: "jane@ucsd.edu" },
      }),
      "",
    ].join("\n"));
    const app = createDashboardHonoApp({ dir, stateDb: db, workflow: "onboarding", projectionReady: false });
    const res = await app.request(`/api/runs?workflow=onboarding&id=${encodeURIComponent("jane@ucsd.edu")}&date=${date}`);
    assert.equal(res.status, 200);
    const body = await res.json() as Array<{ runId: string; status: string; step?: string; stepDurations?: Record<string, number> }>;
    assert.equal(body.length, 1);
    assert.equal(body[0].runId, "jane@ucsd.edu#1");
    assert.equal(body[0].status, "done");
    assert.equal(body[0].step, "transaction");
    assert.ok(body[0].stepDurations);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono /api/search returns JSONL search results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-search-"));
  // Date-relative to today: /api/search filters to the last `days` calendar
  // days (cutoff = today − (days−1)), so a hardcoded past date ages out of the
  // window and the row vanishes. Use today's local date + timestamp so the row
  // is always inside any positive `days` window.
  const date = dateLocal();
  try {
    const db = openStateDb(dir);
    mkdirSync(rowsDir(dir), { recursive: true });
    writeFileSync(rowFilePath("onboarding", date, dir), JSON.stringify({
      workflow: "onboarding",
      timestamp: new Date().toISOString(),
      id: "jane@ucsd.edu",
      runId: "jane@ucsd.edu#1",
      status: "done",
      data: { firstName: "Jane", lastName: "Smith", email: "jane@ucsd.edu" },
    }) + "\n");
    const app = createDashboardHonoApp({ dir, stateDb: db });
    const res = await app.request("/api/search?q=Jane&workflow=onboarding&limit=5&days=30");
    assert.equal(res.status, 200);
    const body = await res.json() as Array<{ workflow: string; id: string }>;
    assert.deepEqual(body.map((row) => ({ workflow: row.workflow, id: row.id })), [
      { workflow: "onboarding", id: "jane@ucsd.edu" },
    ]);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono screenshot routes list grouped screenshots and stream image files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-screenshots-"));
  const shotsDir = join(dir, "screenshots");
  const filename = `onboarding-hono-phase1-step-ucpath-${Date.now()}.png`;
  const screenshotPath = join(shotsDir, filename);
  try {
    const db = openStateDb(dir);
    mkdirSync(shotsDir, { recursive: true });
    writeFileSync(screenshotPath, Buffer.from("png bytes"));
    trackEvent(
      {
        workflow: "onboarding",
        timestamp: new Date().toISOString(),
        id: "hono-phase1",
        runId: "hono-run-1",
        status: "running",
        data: {},
      },
      dir,
    );
    emitScreenshotEvent(
      {
        type: "screenshot",
        runId: "hono-run-1",
        ts: Date.now(),
        timestamp: new Date().toISOString(),
        kind: "form",
        label: "step-capture",
        step: "step",
        files: [{ system: "ucpath", path: screenshotPath }],
      },
      { dir },
    );

    const app = createDashboardHonoApp({ dir, stateDb: db, workflow: "onboarding", screenshotsDir: shotsDir });

    const list = await app.request("/api/screenshots?workflow=onboarding&id=hono-phase1");
    assert.equal(list.status, 200);
    const rows = await list.json() as Array<{ label: string; files: Array<{ url: string }> }>;
    assert.equal(rows[0].label, "step-capture");
    assert.equal(rows[0].files[0].url, `/screenshots/${encodeURIComponent(filename)}`);

    const image = await app.request(`/screenshots/${encodeURIComponent(filename)}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await image.arrayBuffer()).toString("utf8"), "png bytes");
  } finally {
    rmSync(screenshotPath, { force: true });
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono /api/preflight does not prune screenshots (use npm run clean:tracker)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-preflight-"));
  const shotsDir = join(dir, "shots");
  const oldTs = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const filename = `onboarding-hono-old-error-step-ucpath-${oldTs}.png`;
  const screenshotPath = join(shotsDir, filename);
  try {
    __resetPreflightThrottleForTests();
    const db = openStateDb(dir);
    mkdirSync(shotsDir, { recursive: true });
    writeFileSync(screenshotPath, Buffer.from("png bytes"));
    const app = createDashboardHonoApp({
      dir,
      stateDb: db,
      workflow: "onboarding",
      screenshotsDir: shotsDir,
    });

    const res = await app.request("/api/preflight");

    assert.equal(res.status, 200);
    assert.equal(existsSync(screenshotPath), true, "preflight must not delete screenshots on dashboard cadence");
  } finally {
    __resetPreflightThrottleForTests();
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono /api/prep/pdf-page streams legacy prepared page image", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-pdf-page-"));
  const parentRunId = `hono-phase1-${Date.now()}`;
  const pageDir = join(dir, "uploads", parentRunId);
  try {
    const db = openStateDb(dir);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "page-01.png"), Buffer.from("page one"));
    const app = createDashboardHonoApp({ dir, stateDb: db });
    const res = await app.request(`/api/prep/pdf-page?workflow=ocr&parentRunId=${parentRunId}&page=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString("utf8"), "page one");
  } finally {
    rmSync(pageDir, { recursive: true, force: true });
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono /api/files routes stream registered local files and cached pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-files-"));
  try {
    const db = openStateDb(dir);
    const pdfPath = join(dir, "sample.pdf");
    const pagePath = join(dir, "page-001.png");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n% sample\n%%EOF\n"));
    writeFileSync(pagePath, Buffer.from("page image bytes"));
    const file = registerLocalFile(db, {
      kind: "pdf",
      mimeType: "application/pdf",
      path: pdfPath,
      originalName: "sample.pdf",
      source: "test",
    });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO file_pages (
        file_id, page, render_version, status, image_path, mime_type, bytes, error, created_at, updated_at
      ) VALUES (
        @fileId, 1, 2, 'ready', @imagePath, 'image/png', @bytes, NULL, @now, @now
      )
    `).run({ fileId: file.fileId, imagePath: pagePath, bytes: statSync(pagePath).size, now });

    const app = createDashboardHonoApp({ dir, stateDb: db });
    const original = await app.request(`/api/files/${file.fileId}/original`);
    assert.equal(original.status, 200);
    assert.equal(original.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await original.arrayBuffer()).toString("utf8"), "%PDF-1.4\n% sample\n%%EOF\n");

    const page = await app.request(`/api/files/${file.fileId}/pages/1`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "image/png");
    assert.equal(page.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(Buffer.from(await page.arrayBuffer()).toString("utf8"), "page image bytes");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono /api/files page route rejects invalid page params", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-file-pages-invalid-"));
  try {
    const db = openStateDb(dir);
    const app = createDashboardHonoApp({ dir, stateDb: db });
    for (const page of ["NaN", "0", "-1", "100000"]) {
      const res = await app.request(`/api/files/test-file/pages/${page}`);
      assert.equal(res.status, 400);
      assert.equal(await res.text(), "invalid page");
    }
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hono static routes serve prod dashboard without swallowing missing API routes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-static-"));
  const staticDir = join(dir, "dist");
  try {
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>HR Dashboard</title>");
    const db = openStateDb(dir);
    const app = createDashboardHonoApp({ dir, stateDb: db, staticDir });

    const root = await app.request("/");
    assert.equal(root.status, 200);
    assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await root.text(), "<!doctype html><title>HR Dashboard</title>");

    const spaPath = await app.request("/workflow/onboarding");
    assert.equal(spaPath.status, 200);
    assert.equal(await spaPath.text(), "<!doctype html><title>HR Dashboard</title>");

    const missingApi = await app.request("/api/not-a-real-route");
    assert.equal(missingApi.status, 404);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
