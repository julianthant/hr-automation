import { afterEach, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { rowFilePath, rowsDir } from "../../../src/tracker/paths.js";
import { _resetSessionLockForTests } from "../../../src/tracker/dashboard/ocr/index.js";
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

test("Hono /api/ocr/prepare accepts rosterMode 'none' (the run-modal 'No roster' pick)", async () => {
  // "none" must survive the route's roster-mode validation and reach prepare —
  // the route once rejected it while the prepare contract accepted it, 400-ing
  // the OnBase "No roster" upload. The bogus formType makes prepare itself
  // answer (a formType 400, NOT a rosterMode 400) without launching a run.
  const body = new FormData();
  body.set("pdf", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "no-roster.pdf", { type: "application/pdf" }));
  body.set("formType", "not-a-real-form");
  body.set("rosterMode", "none");
  const res = await app().request("/api/ocr/prepare", { method: "POST", body });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: 'Unknown formType "not-a-real-form"' });
});

test("Hono /api/ocr/prepare still rejects an unrecognized rosterMode, naming every valid mode", async () => {
  const body = new FormData();
  body.set("pdf", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "bad-mode.pdf", { type: "application/pdf" }));
  body.set("formType", "oath");
  body.set("rosterMode", "bogus");
  const res = await app().request("/api/ocr/prepare", { method: "POST", body });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: 'rosterMode: "bogus" is not one of existing | download | wait | none',
  });
});

test("Hono /api/ocr/approve-batch 400s a malformed body with the offending fields named", async () => {
  const res = await app().request("/api/ocr/approve-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "", runId: "", records: [] }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: "sessionId: must be a non-empty string; runId: must be a non-empty string",
  });
});

test("Hono /api/ocr/approve-batch forwards body without preview fields", async () => {
  const sessionId = "session-preview-route";
  const runId = "run-preview-route";
  mkdirSync(rowsDir(dir), { recursive: true });
  writeFileSync(rowFilePath("ocr", todayLocal(), dir), JSON.stringify({
    workflow: "ocr",
    id: sessionId,
    runId,
    parentRunId: "op-parent-preview-route",
    status: "done",
    step: "awaiting-approval",
    timestamp: "2026-05-05T00:00:00.000Z",
    data: {
      formType: "oath",
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      sessionId,
      records: JSON.stringify([]),
    },
  }) + "\n");

  const res = await app().request("/api/ocr/approve-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      runId,
      records: [],
    }),
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: "No selected records to approve" });
});
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
