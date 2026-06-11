import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("sharepoint-download: registers as kernel workflow on import", async () => {
  // vi.resetModules() gives the workflow file a fresh registry to register
  // into. We must then re-import both the registry and the workflow module
  // so getByName queries the same instance the workflow just registered
  // into — the statically-imported registry.js would point at a different
  // (cleared) module instance.
  vi.resetModules();
  const { getByName } = await import("../../../src/core/kernel/registry.js");
  await import("../../../src/workflows/sharepoint-download/workflow.js");
  const meta = getByName("sharepoint-download");
  assert.ok(meta, "sharepoint-download should be registered");
  assert.equal(meta.label, "SharePoint Download");
  // authSteps: true → kernel auto-prepends `auth:sharepoint` before the
  // declared steps. The workflow must appear in the dropdown with 3 effective
  // phases (auth + navigate + download).
  assert.deepEqual(meta.steps, ["auth:sharepoint", "navigate", "download"]);
  assert.deepEqual(meta.systems, ["sharepoint"]);
  assert.deepEqual(meta.detailFields, [
    { key: "label", label: "Spreadsheet" },
    { key: "filename", label: "File" },
    { key: "path", label: "Saved to" },
  ]);
});

test("buildSharePointRosterDownloadHandler: fires kernel runWorkflow and returns 202", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sp-handler-"));
  t.onTestFinished(() => rmSync(tmp, { recursive: true, force: true }));

  const { buildSharePointRosterDownloadHandler, _resetInFlightForTests } =
    await import("../../../src/workflows/sharepoint-download/handler.js");

  _resetInFlightForTests();

  type CapturedInput = { id: string; label: string; url: string; outDir: string };
  const captured: CapturedInput[] = [];
  const handler = buildSharePointRosterDownloadHandler({
    outDir: tmp,
    getEnv: (name) =>
      name === "ONBOARDING_ROSTER_URL" ? "https://example.com/file.xlsx" : undefined,
    // Mock the kernel runner — don't actually launch a browser. We delay
    // to simulate the real run taking time, so the handler's 202 must be
    // returned BEFORE this promise resolves.
    runWorkflowFn: (async (_wf, input) => {
      captured.push(input as CapturedInput);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }) as typeof import("../../../src/core/kernel/workflow.js").runWorkflow,
  });

  const start = Date.now();
  const res = await handler({ id: "onboarding" });
  const elapsed = Date.now() - start;

  assert.equal(res.status, 202);
  assert.ok("ok" in res.body && res.body.ok, "response should be ok:true");
  if ("ok" in res.body && res.body.ok) {
    assert.equal(res.body.id, "onboarding");
    assert.equal(res.body.label, "Onboarding Roster");
    assert.equal(res.body.status, "launched");
  }
  assert.ok(elapsed < 40, `handler should return before 50ms mock runWorkflow (got ${elapsed}ms)`);

  // Let the background run complete so the lock clears.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(captured.length, 1, "runWorkflow should be called exactly once");
  const input = captured[0];
  assert.equal(input.id, "onboarding");
  assert.equal(input.label, "Onboarding Roster");
  assert.equal(input.url, "https://example.com/file.xlsx");
});

test("buildSharePointRosterDownloadHandler: 400 when env var unset", async () => {
  const { buildSharePointRosterDownloadHandler, _resetInFlightForTests } =
    await import("../../../src/workflows/sharepoint-download/handler.js");
  _resetInFlightForTests();

  const handler = buildSharePointRosterDownloadHandler({
    getEnv: () => undefined,
  });
  const res = await handler({ id: "onboarding" });
  assert.equal(res.status, 400);
  assert.ok("ok" in res.body && !res.body.ok);
  if ("ok" in res.body && !res.body.ok) {
    assert.match(res.body.error, /ONBOARDING_ROSTER_URL/);
  }
});

test("buildSharePointRosterDownloadHandler: 404 on unknown id", async () => {
  const { buildSharePointRosterDownloadHandler, _resetInFlightForTests } =
    await import("../../../src/workflows/sharepoint-download/handler.js");
  _resetInFlightForTests();

  const handler = buildSharePointRosterDownloadHandler({
    getEnv: () => "https://example.com",
  });
  const res = await handler({ id: "bogus" });
  assert.equal(res.status, 404);
});

test("buildSharePointRosterDownloadHandler: queues a fresh concurrent run behind the current one", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sp-queue-"));
  t.onTestFinished(() => rmSync(tmp, { recursive: true, force: true }));

  const { buildSharePointRosterDownloadHandler, getSharePointDownloadStatus, _resetInFlightForTests } =
    await import("../../../src/workflows/sharepoint-download/handler.js");
  _resetInFlightForTests();

  const started: string[] = [];
  const handler = buildSharePointRosterDownloadHandler({
    outDir: tmp,
    getEnv: () => "https://example.com/file.xlsx",
    runWorkflowFn: (async (_wf, input) => {
      started.push((input as { id: string }).id);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }) as typeof import("../../../src/core/kernel/workflow.js").runWorkflow,
  });

  const first = handler({ id: "onboarding" });
  // Wait one tick so the first handler flips the lock before the second call.
  await new Promise((resolve) => setImmediate(resolve));
  const second = await handler({ id: "onboarding" });
  assert.equal(second.status, 202);
  assert.ok("ok" in second.body && second.body.ok);
  if ("ok" in second.body && second.body.ok) {
    assert.equal(second.body.status, "queued");
  }

  const queuedStatus = getSharePointDownloadStatus();
  assert.equal(queuedStatus.inFlight, true);
  assert.equal(queuedStatus.queued.length, 1);
  // The shared status shape (domain/sharepoint-download-status.ts) carries the
  // richer fields the client used to drop in its lossy re-declaration: the
  // in-flight registry id, and per-job queueId + createdAt. Pin them so a future
  // lossy narrowing fails here.
  assert.equal(queuedStatus.inFlightId, "onboarding");
  assert.ok(queuedStatus.current);
  assert.equal(queuedStatus.current?.id, "onboarding");
  assert.match(queuedStatus.current?.queueId ?? "", /^spq-\d+$/);
  assert.match(queuedStatus.current?.createdAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  const queuedJob = queuedStatus.queued[0];
  assert.ok(queuedJob);
  assert.match(queuedJob?.queueId ?? "", /^spq-\d+$/);
  assert.match(queuedJob?.createdAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

  // Drain both queued runs so the module lock clears for any subsequent tests.
  await first;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(started, ["onboarding", "onboarding"]);
  assert.equal(getSharePointDownloadStatus().inFlight, false);
});

test("requestSharePointDownload: wait mode joins the current queued/running job", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sp-wait-"));
  t.onTestFinished(() => rmSync(tmp, { recursive: true, force: true }));

  const { requestSharePointDownload, getSharePointDownloadStatus, _resetInFlightForTests } =
    await import("../../../src/workflows/sharepoint-download/handler.js");
  _resetInFlightForTests();

  const started: string[] = [];
  const runner = (async (_wf, input) => {
    started.push((input as { id: string }).id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }) as typeof import("../../../src/core/kernel/workflow.js").runWorkflow;

  const first = requestSharePointDownload(
    { id: "onboarding", mode: "fresh" },
    {
      outDir: tmp,
      getEnv: () => "https://example.com/file.xlsx",
      runWorkflowFn: runner,
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const waiter = requestSharePointDownload(
    { id: "onboarding", mode: "wait" },
    {
      outDir: tmp,
      getEnv: () => "https://example.com/file.xlsx",
      runWorkflowFn: runner,
    },
  );

  assert.equal(getSharePointDownloadStatus().inFlight, true);
  await Promise.all([first, waiter]);
  assert.deepEqual(started, ["onboarding"]);
});

test("buildSharePointListHandler: maps registry + configured flag", async () => {
  const { buildSharePointListHandler } = await import(
    "../../../src/workflows/sharepoint-download/handler.js"
  );
  const setList = buildSharePointListHandler({
    getEnv: (name) => (name === "ONBOARDING_ROSTER_URL" ? "https://x" : undefined),
  });
  const unsetList = buildSharePointListHandler({ getEnv: () => undefined });
  const setRows = setList();
  const unsetRows = unsetList();
  assert.ok(setRows.length > 0);
  assert.equal(setRows[0].id, "onboarding");
  assert.equal(setRows[0].configured, true);
  assert.equal(unsetRows[0].configured, false);
});
