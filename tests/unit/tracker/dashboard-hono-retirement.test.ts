import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";

import { createDashboardServer } from "../../../src/tracker/dashboard.js";
import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import {
  getDashboardHonoRouteManifest,
  type DashboardHonoRouteManifestEntry,
} from "../../../src/tracker/dashboard/hono/manifest.js";
import { registerLocalFile } from "../../../src/tracker/files/files.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";

let server: Server | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  for (const dir of tempDirs.splice(0)) {
    closeStateDbForTests(dir);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function expectRoute(
  manifest: readonly DashboardHonoRouteManifestEntry[],
  method: string,
  path: string,
): void {
  assert.ok(
    manifest.some((route) => route.method === method && route.path === path),
    `expected Hono manifest to include ${method} ${path}`,
  );
}

function routeKey(method: string, path: string): string {
  return `${method} ${path === "/*" ? "*" : path}`;
}

async function collectOneSsePayload(url: string): Promise<string> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]);
  try {
    const res = await fetch(url, { signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const match = /^data: (.+)$/m.exec(buffered);
      if (match) {
        await reader.cancel();
        return match[1];
      }
    }
  } finally {
    controller.abort();
  }
  assert.fail("expected one SSE data payload");
}

test("Hono manifest covers the dashboard public route inventory", () => {
  const manifest = getDashboardHonoRouteManifest();
  const expected: Array<[string, string]> = [
    ["OPTIONS", "*"],
    ["GET", "/api/v2/projection/health"],
    ["GET", "/api/v2/entries"],
    ["GET", "/api/v2/runs"],
    ["GET", "/api/task-dependencies"],
    ["GET", "/api/files/:fileId/download"],
    ["GET", "/api/files/:fileId/original"],
    ["GET", "/api/files/:fileId/pages/:page"],
    ["GET", "/api/workflows"],
    ["GET", "/api/workflow-definitions"],
    ["GET", "/api/dates"],
    ["GET", "/api/entries"],
    ["GET", "/api/entry-data"],
    ["GET", "/api/logs"],
    ["GET", "/api/runs"],
    ["GET", "/api/rosters"],
    ["GET", "/api/preflight"],
    ["GET", "/api/search"],
    ["GET", "/api/failures"],
    ["GET", "/api/selector-warnings"],
    ["GET", "/api/screenshots"],
    ["GET", "/api/prep/pdf-page"],
    ["GET", "/screenshots/:filename"],
    ["GET", "/api/sharepoint-download/list"],
    ["GET", "/api/sharepoint-download/status"],
    ["POST", "/api/sharepoint-download/run"],
    ["POST", "/api/enqueue"],
    ["POST", "/api/daemon/stop"],
    ["POST", "/api/retry"],
    ["POST", "/api/retry-bulk"],
    ["POST", "/api/run-with-data"],
    ["POST", "/api/save-data"],
    ["POST", "/api/delete-entry"],
    ["POST", "/api/delete-bulk"],
    ["GET", "/api/find-prior-by-key"],
    ["POST", "/api/cancel-queued"],
    ["POST", "/api/cancel-running"],
    ["POST", "/api/cancel-active-bulk"],
    ["POST", "/api/task/force-stop"],
    ["POST", "/api/browser/kill"],
    ["POST", "/api/worker/drain"],
    ["POST", "/api/worker/stop"],
    ["POST", "/api/queue/bump"],
    ["GET", "/api/daemons"],
    ["POST", "/api/daemons/spawn"],
    ["POST", "/api/daemons/stop"],
    ["GET", "/api/queue-depth"],
    ["GET", "/api/ocr/forms"],
    ["POST", "/api/ocr/prepare"],
    ["POST", "/api/ocr/reupload"],
    ["POST", "/api/ocr/approve-batch"],
    ["POST", "/api/ocr/discard-prepare"],
    ["POST", "/api/ocr/force-research"],
    ["POST", "/api/ocr/retry-page"],
    ["POST", "/api/ocr/reocr-whole-pdf"],
    ["GET", "/api/oath-upload/check-duplicate"],
    ["POST", "/api/oath-upload/cancel"],
    ["POST", "/api/oath-upload/start"],
    ["POST", "/api/capture/start"],
    ["GET", "/capture/:token"],
    ["GET", "/api/capture/manifest/:token"],
    ["POST", "/api/capture/upload"],
    ["POST", "/api/capture/delete-photo"],
    ["POST", "/api/capture/finalize"],
    ["POST", "/api/capture/discard"],
    ["GET", "/api/capture/sessions"],
    ["GET", "/api/capture/photos/:sessionId/:index"],
    ["POST", "/api/capture/replace-photo"],
    ["POST", "/api/capture/reorder"],
    ["POST", "/api/capture/extend"],
    ["POST", "/api/capture/validate"],
    ["GET", "/api/capture/registry"],
    ["GET", "/capture-assets/heic2any.min.js"],
    ["GET", "/events/hub"],
    ["GET", "/"],
    ["GET", "/index.html"],
    ["GET", "*"],
  ];
  for (const [method, path] of expected) expectRoute(manifest, method, path);
});

test("Hono manifest stays in sync with registered app routes", () => {
  const dir = makeTempDir("hono-manifest-");
  const app = createDashboardHonoApp({
    workflow: "onboarding",
    port: 0,
    dir,
    stateDb: openStateDb(dir),
    projectionReady: false,
  });
  const manifestRoutes = new Set(
    getDashboardHonoRouteManifest().map((route) => routeKey(route.method, route.path)),
  );
  const appRoutes = new Set(app.routes.map((route) => routeKey(route.method, route.path)));
  assert.deepEqual([...manifestRoutes].sort(), [...appRoutes].sort());
});

test("dashboard server no longer imports the raw route dispatcher or Hono adapter fallback", () => {
  const source = readFileSync(join(process.cwd(), "src/tracker/dashboard/server.ts"), "utf-8");
  assert.equal(source.includes("./routes/"), false);
  assert.equal(source.includes("createDashboardRequestListener"), false);
  assert.equal(source.includes("createHonoDashboardRoute"), false);
});

test("retired raw dashboard route wrappers have been removed", () => {
  const rawRoutesDir = join(process.cwd(), "src/tracker/dashboard/routes");
  assert.equal(existsSync(rawRoutesDir), false, `expected raw route directory to be removed, found: ${
    existsSync(rawRoutesDir) ? readdirSync(rawRoutesDir).join(", ") : ""
  }`);
  assert.equal(existsSync(join(process.cwd(), "src/tracker/dashboard/route-types.ts")), false);
  assert.equal(existsSync(join(process.cwd(), "src/tracker/dashboard/http.ts")), false);
  assert.equal(existsSync(join(process.cwd(), "src/tracker/dashboard/static-files.ts")), false);
  assert.equal(existsSync(join(process.cwd(), "src/tracker/dashboard/hono/adapter.ts")), false);
});

test("dashboard server Hono-only listener serves representative routes", async () => {
  const dir = makeTempDir("hono-server-");
  const db = openStateDb(dir);
  const originalPath = join(dir, "sample.pdf");
  writeFileSync(originalPath, Buffer.from("%PDF-1.4\n% route smoke\n%%EOF\n"));
  const file = registerLocalFile(db, {
    kind: "pdf",
    mimeType: "application/pdf",
    path: originalPath,
    originalName: "sample.pdf",
    source: "test",
  });

  server = createDashboardServer({ port: 0, dir, noClean: true, uploadPort: null });
  const port = (server.address() as { port: number }).port;

  const definitions = await fetch(`http://localhost:${port}/api/workflow-definitions`);
  assert.equal(definitions.status, 200);
  assert.equal(Array.isArray(await definitions.json()), true);

  const hubSubs = encodeURIComponent(
    JSON.stringify([{ id: "e1", topic: "entries", params: { workflow: "onboarding" } }]),
  );
  const hubEnvelope = JSON.parse(await collectOneSsePayload(`http://localhost:${port}/events/hub?subs=${hubSubs}`));
  // Hub envelope shape: { sub, data: { entries, workflows, wfCounts, failureCounts } }
  assert.equal(typeof hubEnvelope.sub, "string");
  assert.equal(Array.isArray(hubEnvelope.data.entries), true);

  const original = await fetch(`http://localhost:${port}/api/files/${file.fileId}/original`);
  assert.equal(original.status, 200);
  assert.equal(await original.text(), "%PDF-1.4\n% route smoke\n%%EOF\n");

  const queueDepth = await fetch(`http://localhost:${port}/api/queue-depth`);
  assert.equal(queueDepth.status, 200);
  assert.equal(typeof await queueDepth.json(), "object");

  const ocrForms = await fetch(`http://localhost:${port}/api/ocr/forms`);
  assert.equal(ocrForms.status, 200);
  assert.equal(Array.isArray(await ocrForms.json()), true);
});
