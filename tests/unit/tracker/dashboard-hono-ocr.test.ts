import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
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

test("Hono /api/ocr/approve-batch forwards validation errors", async () => {
  const res = await app().request("/api/ocr/approve-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "", runId: "", records: [] }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: "Missing sessionId/runId/records" });
});

test("Hono /api/ocr/approve-batch forwards preview readiness to the approval handler", async () => {
  const sessionId = "session-preview-route";
  const runId = "run-preview-route";
  writeFileSync(join(dir, `ocr-${todayLocal()}.jsonl`), JSON.stringify({
    workflow: "ocr",
    id: sessionId,
    runId,
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
      previewReady: true,
      previewPageCount: 1,
    }),
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: "No selected records to approve" });
});

// Case (j): verify the route plumbing does NOT silently drop previewReady=false,
// meaning the approval handler still rejects with the preview error (not some other 400).
test("Hono /api/ocr/approve-batch rejects when previewReady is false (route plumbing)", async () => {
  const sessionId = "session-route-plumbing-false";
  const runId = "run-route-plumbing-false";
  writeFileSync(join(dir, `ocr-${todayLocal()}.jsonl`), JSON.stringify({
    workflow: "ocr",
    id: sessionId,
    runId,
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
      records: [{ employeeId: "10000001", printedName: "Alice", selected: true,
        matchState: "matched", employeeSigned: true, officerSigned: true,
        dateSigned: "05/01/2026", sourcePage: 1, rowIndex: 0 }],
      previewReady: false,
      previewPageCount: 1,
    }),
  });

  assert.equal(res.status, 400);
  const body = await res.json() as { ok: false; error: string };
  assert.match(body.error, /Source preview is not available/);
});

// Case (j): verify previewPageCount=0 is forwarded (not coerced to truthy)
test("Hono /api/ocr/approve-batch rejects when previewPageCount is 0 (route plumbing)", async () => {
  const sessionId = "session-route-plumbing-zero";
  const runId = "run-route-plumbing-zero";
  writeFileSync(join(dir, `ocr-${todayLocal()}.jsonl`), JSON.stringify({
    workflow: "ocr",
    id: sessionId,
    runId,
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
      records: [{ employeeId: "10000001", printedName: "Alice", selected: true,
        matchState: "matched", employeeSigned: true, officerSigned: true,
        dateSigned: "05/01/2026", sourcePage: 1, rowIndex: 0 }],
      previewReady: true,
      previewPageCount: 0,
    }),
  });

  assert.equal(res.status, 400);
  const body = await res.json() as { ok: false; error: string };
  assert.match(body.error, /Source preview is not available/);
});

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
