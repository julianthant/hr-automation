import { afterEach, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";

let dir: string;
let previousPublicUrl: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hono-capture-"));
  previousPublicUrl = process.env.CAPTURE_PUBLIC_URL;
  process.env.CAPTURE_PUBLIC_URL = "http://127.0.0.1:3838";
});

afterEach(() => {
  if (previousPublicUrl === undefined) delete process.env.CAPTURE_PUBLIC_URL;
  else process.env.CAPTURE_PUBLIC_URL = previousPublicUrl;
  closeStateDbForTests(dir);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function app() {
  return createDashboardHonoApp({ dir, stateDb: openStateDb(dir), port: 3838 });
}

test("Hono capture start creates a manifest-visible session", async () => {
  const start = await app().request("/api/capture/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow: "oath-signature", contextHint: "paper oath" }),
  });
  assert.equal(start.status, 200);
  const startBody = await start.json() as { ok: boolean; token: string; captureUrl: string };
  assert.equal(startBody.ok, true);
  assert.match(startBody.captureUrl, /^http:\/\/127\.0\.0\.1:3838\/capture\//);

  const manifest = await app().request(`/api/capture/manifest/${startBody.token}`);
  assert.equal(manifest.status, 200);
  const manifestBody = await manifest.json() as { ok: boolean; workflow: string; contextHint?: string };
  assert.equal(manifestBody.ok, true);
  assert.equal(manifestBody.workflow, "oath-signature");
  assert.equal(manifestBody.contextHint, "paper oath");
});

test("Hono capture upload missing file returns 400", async () => {
  const start = await app().request("/api/capture/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow: "oath-signature" }),
  });
  const { token } = await start.json() as { token: string };
  const body = new FormData();
  const upload = await app().request(`/api/capture/upload?token=${token}`, { method: "POST", body });
  assert.equal(upload.status, 400);
  assert.deepEqual(await upload.json(), { ok: false, error: "missing 'file' part" });
});

test("Hono capture registry remains available", async () => {
  const res = await app().request("/api/capture/registry");
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, { label: string }>;
  assert.equal(body["oath-signature"].label, "Capture paper roster");
});
