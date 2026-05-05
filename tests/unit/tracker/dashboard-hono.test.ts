import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { queryProjectionHealth } from "../../../src/tracker/state/queries.js";
import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { registerLocalFile } from "../../../src/tracker/files.js";
import { trackEventForDate } from "../../../src/tracker/jsonl.js";
import { clear, defineDashboardMetadata } from "../../../src/core/registry.js";
import { defineWorkflow } from "../../../src/core/workflow.js";
import { SCREENSHOTS_DIR } from "../../../src/tracker/dashboard/screenshots.js";

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
    defineDashboardMetadata({
      name: "legacy-hono",
      label: "Legacy Hono",
      systems: ["crm"],
      steps: ["one"],
      detailFields: [],
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
    writeFileSync(join(dir, `onboarding-${date}.jsonl`), [
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
  const date = "2026-05-04";
  try {
    const db = openStateDb(dir);
    writeFileSync(join(dir, `onboarding-${date}.jsonl`), JSON.stringify({
      workflow: "onboarding",
      timestamp: "2026-05-04T12:00:00.000Z",
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
  const filename = `onboarding-hono-phase1-step-ucpath-${Date.now()}.png`;
  const screenshotPath = join(SCREENSHOTS_DIR, filename);
  try {
    const db = openStateDb(dir);
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    writeFileSync(screenshotPath, Buffer.from("png bytes"));
    const app = createDashboardHonoApp({ dir, stateDb: db, workflow: "onboarding" });

    const list = await app.request("/api/screenshots?workflow=onboarding&id=hono-phase1");
    assert.equal(list.status, 200);
    const rows = await list.json() as Array<{ label: string; files: Array<{ url: string }> }>;
    assert.equal(rows[0].label, "legacy");
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

test("Hono /api/prep/pdf-page streams legacy prepared page image", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-pdf-page-"));
  const parentRunId = `hono-phase1-${Date.now()}`;
  const pageDir = join(process.cwd(), ".tracker", "uploads", parentRunId);
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
        @fileId, 1, 1, 'ready', @imagePath, 'image/png', @bytes, NULL, @now, @now
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
