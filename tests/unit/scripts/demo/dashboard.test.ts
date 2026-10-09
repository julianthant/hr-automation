import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoDashboard } from "../../../../src/scripts/demo/dashboard.js";
import { closeStateDb } from "../../../../src/tracker/state/db.js";

test("mock preview serves synthetic rows and denies every live entry point", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-demo-test-"));
  t.onTestFinished(() => { closeStateDb(dir); rmSync(dir, { recursive: true, force: true }); });
  const app = createDemoDashboard(dir, dir);
  const response = await app.request("/api/entries?workflow=person-lookup");
  assert.equal(response.status, 200);
  const rows = await response.json() as Array<{ data: { name: string; emplId: string } }>;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.data.name.startsWith("Example,") && /^9000000[1-3]$/.test(row.data.emplId)));
  const projection = await app.request("/api/v2/entries?workflow=person-lookup");
  assert.equal(projection.status, 200);
  assert.match(await projection.text(), /Example,/);
  for (const path of ["/api/enqueue", "/api/daemons/spawn", "/api/ocr/prepare", "/api/settings", "/api/sharepoint-download/run"]) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const blocked = await app.request(path, { method });
      assert.equal(blocked.status, 403, `${method} ${path}`);
      assert.match(await blocked.text(), /read-only/);
    }
  }
  for (const path of [
    "/api/entries?workflow=../../private/real", "/api/logs?workflow=onboarding",
    "/api/entry-data?date=../../private/real&id=person", "/events/hub?subs=broken",
  ]) assert.equal((await app.request(path)).status, 403, path);
  for (const sub of [
    { id: "bad", topic: "entries", params: { workflow: "../../private/real" } },
    { id: "bad", topic: "logs", params: { workflow: "person-lookup", date: "../../private" } },
    { id: "bad", topic: "unknownTopic", params: {} },
  ]) {
    const blocked = await app.request(`/events/hub?subs=${encodeURIComponent(JSON.stringify([sub]))}`);
    assert.equal(blocked.status, 403);
  }
  for (const path of ["/api/browser/screenshot", "/api/rosters", "/api/prep/pdf-page", "/api/operator/session", "/events/hub/extra", "/.env", "/favicon.svg/extra"]) {
    assert.equal((await app.request(path)).status, 403, path);
  }
});
