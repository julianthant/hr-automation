import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildOcrFormsHandler,
  buildOcrPrepareHandler,
  buildOcrApproveHandler,
  buildOcrDiscardHandler,
  buildOcrForceResearchHandler,
  sweepStuckOcrRows,
  _resetSessionLockForTests,
} from "../../../src/tracker/ocr-http.js";

function setup(): string {
  const dir = join(tmpdir(), `ocr-http-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("GET /api/ocr/forms returns registry listing", () => {
  const handler = buildOcrFormsHandler();
  const result = handler();
  assert.ok(result.length >= 2);
  const oath = result.find((f) => f.formType === "oath");
  assert.ok(oath);
  assert.equal(oath.label, "Oath signature");
});

test("POST /api/ocr/prepare returns 202 with sessionId+runId on happy path", async () => {
  const dir = setup();
  _resetSessionLockForTests();
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: async () => {/* fire-and-forget stub */},
  });
  const resp = await handler({
    pdfPath: "/tmp/fake.pdf",
    pdfOriginalName: "fake.pdf",
    formType: "oath",
    rosterMode: "existing",
    rosterPath: "/tmp/roster.xlsx",
  });
  assert.equal(resp.status, 202);
  assert.equal(resp.body.ok, true);
  assert.ok((resp.body as any).sessionId);
  assert.ok((resp.body as any).runId);
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/prepare returns 409 when sessionId is locked", async () => {
  const dir = setup();
  _resetSessionLockForTests();
  let resolveStub: (() => void) | null = null;
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: () => new Promise<void>((resolve) => { resolveStub = resolve; }),
  });
  const sessionId = "session-locked";
  const first = await handler({
    pdfPath: "/tmp/a.pdf", pdfOriginalName: "a.pdf",
    formType: "oath", rosterMode: "existing", rosterPath: "/tmp/r.xlsx",
    sessionId,
  });
  assert.equal(first.status, 202);

  const second = await handler({
    pdfPath: "/tmp/b.pdf", pdfOriginalName: "b.pdf",
    formType: "oath", rosterMode: "existing", rosterPath: "/tmp/r.xlsx",
    sessionId,
  });
  assert.equal(second.status, 409);

  if (resolveStub) (resolveStub as () => void)();
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/reupload requires sessionId + previousRunId", async () => {
  const dir = setup();
  _resetSessionLockForTests();
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: async () => {},
  });
  const resp = await handler({
    pdfPath: "/tmp/fake.pdf", pdfOriginalName: "fake.pdf",
    formType: "oath", rosterMode: "existing", rosterPath: "/tmp/r.xlsx",
    isReupload: true,
    // sessionId + previousRunId omitted
  });
  assert.equal(resp.status, 400);
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/discard-prepare emits failed step=discarded", async () => {
  const dir = setup();
  const handler = buildOcrDiscardHandler({ trackerDir: dir });
  const resp = await handler({ sessionId: "s1", runId: "r1", reason: "user clicked" });
  assert.equal(resp.status, 200);
  const file = join(dir, `ocr-${todayLocal()}.jsonl`);
  assert.ok(existsSync(file));
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.status, "failed");
  assert.equal(last.step, "discarded");
  rmSync(dir, { recursive: true, force: true });
});

test("sweepStuckOcrRows marks running rows failed", () => {
  const dir = setup();
  const file = join(dir, `ocr-${todayLocal()}.jsonl`);
  appendFileSync(file,
    JSON.stringify({
      workflow: "ocr", id: "stuck-session", runId: "r1",
      status: "running", step: "ocr",
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  sweepStuckOcrRows(dir);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.status, "failed");
  assert.match(last.error, /Dashboard restarted/);
  rmSync(dir, { recursive: true, force: true });
});
