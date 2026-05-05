import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { _resetSessionLockForTests } from "../../../src/tracker/ocr-http.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hono-ocr-"));
  _resetSessionLockForTests();
});

afterEach(() => {
  _resetSessionLockForTests();
  closeStateDbForTests(dir);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function app() {
  return createDashboardHonoApp({ dir, stateDb: openStateDb(dir) });
}

test("Hono /api/ocr/forms returns registry listing", async () => {
  const res = await app().request("/api/ocr/forms");
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ formType: string; label: string }>;
  assert.ok(body.some((form) => form.formType === "oath" && form.label === "Oath signature"));
});

test("Hono /api/ocr/prepare missing pdf returns 400", async () => {
  const body = new FormData();
  body.set("formType", "oath");
  body.set("rosterMode", "download");
  const res = await app().request("/api/ocr/prepare", { method: "POST", body });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: "missing 'pdf' file part" });
});

test("Hono /api/ocr/approve-batch forwards validation errors", async () => {
  const res = await app().request("/api/ocr/approve-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "", runId: "", records: [] }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: "Missing sessionId/runId/records" });
});
