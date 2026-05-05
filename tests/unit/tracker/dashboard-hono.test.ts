import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { queryProjectionHealth } from "../../../src/tracker/state/queries.js";
import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";

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

test("Hono app returns 404 for non-Phase-1 paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hono-404-"));
  try {
    const db = openStateDb(dir);
    const app = createDashboardHonoApp({ dir, stateDb: db });
    const res = await app.request("/api/daemons");
    assert.equal(res.status, 404);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
