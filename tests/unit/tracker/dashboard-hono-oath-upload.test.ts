import { afterEach, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hono-oath-upload-"));
});

afterEach(() => {
  closeStateDbForTests(dir);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function app() {
  return createDashboardHonoApp({ dir, stateDb: openStateDb(dir) });
}

test("Hono /api/oath-upload/check-duplicate invalid hash returns 400", async () => {
  const res = await app().request("/api/oath-upload/check-duplicate?hash=nope");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: "invalid hash" });
});

test("Hono /api/oath-upload/start missing pdf returns 400", async () => {
  const body = new FormData();
  body.set("rosterMode", "download");
  const res = await app().request("/api/oath-upload/start", { method: "POST", body });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: "missing 'pdf' file part" });
});
