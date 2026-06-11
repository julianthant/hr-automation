import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  appendFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOcrPrepareHandler,
  buildOcrApproveHandler,
  _resetSessionLockForTests,
} from "../../../../src/tracker/dashboard/ocr/index.js";
import { readOperationWorkflow } from "../../../../src/tracker/dashboard/ocr/shared.js";
import { rowFilePath, rowsDir } from "../../../../src/tracker/paths.js";

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Row {
  workflow: string;
  id: string;
  runId: string;
  parentRunId?: string;
  status: string;
  step?: string;
  data?: Record<string, string>;
}

function readRows(dir: string, workflow: string): Row[] {
  const path = rowFilePath(workflow, todayLocal(), dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
}

function oathRecord(employeeId: string): Record<string, unknown> {
  return {
    formKind: "oath",
    sourcePage: 1,
    rowIndex: 0,
    printedName: "DOE, JANE",
    employeeId,
    employeeSigned: true,
    dateSigned: "4/23/26",
    documentType: "expected",
    originallyMissing: [],
    notes: [],
    matchState: "matched",
    selected: true,
    warnings: [],
  };
}

function seedOathOcrRow(
  dir: string,
  sessionId: string,
  runId: string,
  extra: { parentRunId?: string; operationWorkflow?: string } = {},
): void {
  mkdirSync(rowsDir(dir), { recursive: true });
  appendFileSync(
    rowFilePath("ocr", todayLocal(), dir),
    JSON.stringify({
      workflow: "ocr",
      timestamp: new Date().toISOString(),
      id: sessionId,
      runId,
      ...(extra.parentRunId ? { parentRunId: extra.parentRunId } : {}),
      status: "done",
      step: "awaiting-approval",
      data: {
        archetype: "preview",
        mode: "prepare",
        formType: "oath",
        sessionId,
        pdfOriginalName: "roster.pdf",
        pdfFileId: "file-abc",
        ...(extra.operationWorkflow ? { operationWorkflow: extra.operationWorkflow } : {}),
      },
    }) + "\n",
  );
}

/** Seed an operation coordinator row in a target workflow's panel, as prepare emits it. */
function seedOperationRow(
  dir: string,
  workflow: string,
  sessionId: string,
  operationRunId: string,
  ocrRunId: string,
): void {
  mkdirSync(rowsDir(dir), { recursive: true });
  appendFileSync(
    rowFilePath(workflow, todayLocal(), dir),
    JSON.stringify({
      workflow,
      timestamp: new Date().toISOString(),
      id: `ocr-prep-${sessionId}`,
      runId: operationRunId,
      status: "running",
      step: "ocr-prep",
      data: {
        archetype: "operation",
        mode: "prepare",
        formType: "oath",
        queueRowKind: "file",
        pdfOriginalName: "oaths.pdf",
        ocrRunId,
        ocrSessionId: sessionId,
        operationWorkflow: workflow,
        ocrStatus: "awaiting-review",
        ocrStep: "awaiting-approval",
      },
    }) + "\n",
  );
}

test("prepare with targetWorkflow=oath-signature creates an operation row and delegates OCR under it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-op-prep-"));
  _resetSessionLockForTests();
  try {
    let seenInput: Record<string, unknown> | undefined;
    const handler = buildOcrPrepareHandler({
      trackerDir: dir,
      runOrchestrator: async (input) => {
        seenInput = input as unknown as Record<string, unknown>;
      },
    });
    const resp = await handler({
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "oaths.pdf",
      formType: "oath",
      targetWorkflow: "oath-signature",
      rosterMode: "existing",
      rosterPath: "/tmp/roster.xlsx",
      sessionId: "sess-op",
    });
    assert.equal(resp.status, 202);
    const body = resp.body as { ok: true; sessionId: string; runId: string; parentRunId?: string };
    assert.ok(body.parentRunId, "the operation runId is returned as parentRunId");

    await new Promise((r) => setTimeout(r, 0));
    // OCR is delegated under the operation row and carries the intent.
    assert.equal(seenInput?.parentRunId, body.parentRunId);
    assert.equal(seenInput?.operationWorkflow, "oath-signature");

    // The operation coordinator row landed in the oath-signature panel.
    const op = readRows(dir, "oath-signature").find((r) => r.id === "ocr-prep-sess-op");
    assert.ok(op, "operation row emitted in the target workflow");
    assert.equal(op!.runId, body.parentRunId);
    assert.equal(op!.data?.archetype, "operation");
    assert.equal(op!.data?.mode, "prepare");
    assert.equal(op!.data?.formType, "oath");
    assert.equal(op!.data?.queueRowKind, "file");
    assert.equal(op!.data?.pdfOriginalName, "oaths.pdf");
    assert.equal(op!.data?.ocrRunId, body.runId);
    assert.equal(op!.data?.ocrSessionId, "sess-op");
    assert.equal(op!.data?.operationWorkflow, "oath-signature");
    assert.equal(op!.data?.ocrStatus, "running");
    assert.match(op!.data?.__traceId ?? "", /^os-\d{6}-[a-z0-9]{4}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare with targetWorkflow=emergency-contact creates an emergency-contact operation row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-op-ec-"));
  _resetSessionLockForTests();
  try {
    const handler = buildOcrPrepareHandler({
      trackerDir: dir,
      runOrchestrator: async () => {},
    });
    const resp = await handler({
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "contacts.pdf",
      formType: "emergency-contact",
      targetWorkflow: "emergency-contact",
      rosterMode: "existing",
      rosterPath: "/tmp/roster.xlsx",
      sessionId: "sess-ec",
    });
    assert.equal(resp.status, 202);
    const op = readRows(dir, "emergency-contact").find((r) => r.id === "ocr-prep-sess-ec");
    assert.ok(op, "operation row emitted for emergency-contact");
    assert.equal(op!.data?.archetype, "operation");
    assert.equal(op!.data?.operationWorkflow, "emergency-contact");
    assert.equal(op!.data?.pdfOriginalName, "contacts.pdf");
    assert.match(op!.data?.__traceId ?? "", /^ec-\d{6}-[a-z0-9]{4}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare without targetWorkflow creates no operation row (standalone OCR)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-op-standalone-"));
  _resetSessionLockForTests();
  try {
    let seenInput: Record<string, unknown> | undefined;
    const handler = buildOcrPrepareHandler({
      trackerDir: dir,
      runOrchestrator: async (input) => {
        seenInput = input as unknown as Record<string, unknown>;
      },
    });
    const resp = await handler({
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "roster.pdf",
      formType: "oath",
      rosterMode: "existing",
      rosterPath: "/tmp/roster.xlsx",
      sessionId: "sess-standalone",
    });
    assert.equal(resp.status, 202);
    assert.equal((resp.body as { parentRunId?: string }).parentRunId, undefined);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(seenInput?.parentRunId, undefined);
    assert.equal(seenInput?.operationWorkflow, undefined);
    // No coordinator row in any downstream panel.
    assert.equal(readRows(dir, "oath-signature").length, 0);
    assert.equal(readRows(dir, "oath-upload").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readOperationWorkflow reads the stamped operation intent off the OCR row", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-op-reader-"));
  try {
    seedOathOcrRow(dir, "sess-r", "ocr-run-r", { operationWorkflow: "oath-signature" });
    assert.equal(readOperationWorkflow("sess-r", dir), "oath-signature");
    assert.equal(readOperationWorkflow("sess-missing", dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve for an oath-signature operation fans out signers only (no oath-upload ticket), parented to the operation run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-op-oath-sig-"));
  try {
    seedOathOcrRow(dir, "sess-op", "ocr-run-op", {
      parentRunId: "op-run-1",
      operationWorkflow: "oath-signature",
    });

    const calls: Array<{ workflow: string; inputs: unknown[]; parentRunId?: string }> = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId, opts) => {
        const itemIds = inputs.map((inp, i) => deriveItemId(inp, i));
        calls.push({ workflow, inputs, parentRunId: opts?.parentRunId });
        return { enqueued: itemIds.map((id) => ({ id })) };
      },
    });

    const res = await handler({
      sessionId: "sess-op",
      runId: "ocr-run-op",
      records: [oathRecord("10000001")],
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: true; fannedOut: Array<{ workflow: string; itemId: string }> };
    const workflows = body.fannedOut.map((f) => f.workflow);
    assert.ok(workflows.includes("oath-signature"), "signers fan out");
    assert.equal(
      workflows.includes("oath-upload"),
      false,
      "an oath-signature PDF run files NO ServiceNow ticket",
    );

    await new Promise((r) => setTimeout(r, 300));
    const sigCall = calls.find((c) => c.workflow === "oath-signature");
    assert.ok(sigCall, "oath-signature enqueued");
    assert.equal(sigCall!.parentRunId, "op-run-1", "signers parent to the operation run");
    assert.equal(calls.find((c) => c.workflow === "oath-upload"), undefined, "no oath-upload enqueue");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve mirrors ocrStatus=approved onto the oath-signature operation coordinator row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-op-mirror-"));
  try {
    seedOathOcrRow(dir, "sess-op", "ocr-run-op", {
      parentRunId: "op-run-1",
      operationWorkflow: "oath-signature",
    });
    // Coordinator row seeded mid-flight as prepare/orchestrator left it.
    seedOperationRow(dir, "oath-signature", "sess-op", "op-run-1", "ocr-run-op");

    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId) => {
        const itemIds = inputs.map((inp, i) => deriveItemId(inp, i));
        return { enqueued: itemIds.map((id) => ({ id })) };
      },
    });
    const res = await handler({
      sessionId: "sess-op",
      runId: "ocr-run-op",
      records: [oathRecord("10000001")],
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));

    // The latest coordinator row flips awaiting-review → approved so its surface
    // doesn't read stale in the window before signer members fan out, while its
    // operation archetype + display metadata survive the re-emit.
    const opRows = readRows(dir, "oath-signature").filter((r) => r.id === "ocr-prep-sess-op");
    const latestOp = opRows[opRows.length - 1];
    assert.ok(latestOp, "operation coordinator row present");
    assert.equal(latestOp.runId, "op-run-1");
    assert.equal(latestOp.data?.archetype, "operation", "archetype preserved");
    assert.equal(latestOp.data?.ocrStatus, "approved");
    assert.equal(latestOp.data?.ocrStep, "approved");
    assert.equal(latestOp.data?.pdfOriginalName, "oaths.pdf", "display metadata preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve does NOT mirror an operation row for an oath-upload run (real task, not a coordinator)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-op-ou-nomirror-"));
  try {
    seedOathOcrRow(dir, "sess-ou", "ocr-run-ou", {
      parentRunId: "oath-upload-run-1",
      operationWorkflow: "oath-upload",
    });
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId) => {
        const itemIds = inputs.map((inp, i) => deriveItemId(inp, i));
        return { enqueued: itemIds.map((id) => ({ id })) };
      },
    });
    const res = await handler({
      sessionId: "sess-ou",
      runId: "ocr-run-ou",
      records: [oathRecord("10000001")],
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    // No `ocr-prep-*` coordinator row is fabricated in the oath-upload panel.
    const opRows = readRows(dir, "oath-upload").filter((r) => r.id === "ocr-prep-sess-ou");
    assert.equal(opRows.length, 0, "no coordinator mirror for oath-upload");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare with targetWorkflow=oath-upload enqueues the oath-upload task and delegates OCR under it (option A)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-op-ou-"));
  _resetSessionLockForTests();
  try {
    let enqueueArgs: { sessionId: string; pdfOriginalName: string } | undefined;
    let seenInput: Record<string, unknown> | undefined;
    const handler = buildOcrPrepareHandler({
      trackerDir: dir,
      runOrchestrator: async (input) => {
        seenInput = input as unknown as Record<string, unknown>;
      },
      enqueueOathUploadAtPrepare: async (args) => {
        enqueueArgs = args;
        return "oath-upload-run-xyz";
      },
    });
    const resp = await handler({
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "oaths.pdf",
      formType: "oath",
      targetWorkflow: "oath-upload",
      rosterMode: "existing",
      rosterPath: "/tmp/roster.xlsx",
      sessionId: "sess-ou",
    });
    assert.equal(resp.status, 202);
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(enqueueArgs, "oath-upload task is enqueued at prepare (born at upload)");
    assert.equal(enqueueArgs!.sessionId, "sess-ou");
    assert.equal(enqueueArgs!.pdfOriginalName, "oaths.pdf");
    // OCR is delegated under the oath-upload task and carries the intent.
    assert.equal(seenInput?.parentRunId, "oath-upload-run-xyz");
    assert.equal(seenInput?.operationWorkflow, "oath-upload");
    // Oath Upload is NOT a display coordinator — no `operation` row is created.
    assert.equal(readRows(dir, "oath-signature").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare fails loud (aborts the OCR run) when the oath-upload task cannot be created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-op-ou-failloud-"));
  _resetSessionLockForTests();
  try {
    let orchestratorRan = false;
    const handler = buildOcrPrepareHandler({
      trackerDir: dir,
      runOrchestrator: async () => {
        orchestratorRan = true;
      },
      // Simulate the born-at-upload oath-upload task failing to materialize.
      enqueueOathUploadAtPrepare: async () => undefined,
    });
    const resp = await handler({
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "oaths.pdf",
      formType: "oath",
      targetWorkflow: "oath-upload",
      rosterMode: "existing",
      rosterPath: "/tmp/roster.xlsx",
      sessionId: "sess-ou-fail",
    });
    assert.equal(resp.status, 202);
    await new Promise((r) => setTimeout(r, 20));

    // The OCR orchestrator never ran — no orphaned, consumer-less OCR run that
    // would sign oaths but file no ticket.
    assert.equal(orchestratorRan, false, "OCR run aborted, not left orphaned");
    // A failed oath-upload row surfaces the abort so the operator re-uploads.
    const failed = readRows(dir, "oath-upload").find(
      (r) => r.id === "sess-ou-fail" && r.status === "failed",
    );
    assert.ok(failed, "failed oath-upload row emitted");
    assert.equal(failed!.step, "ocr-prep-failed");
    assert.equal(failed!.data?.archetype, "single");
    assert.match(failed!.data?.__traceId ?? "", /^ou-\d{6}-[a-z0-9]{4}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve for an oath-upload operation fans out signers only (its existing task files the ticket)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-op-oath-upload-"));
  try {
    seedOathOcrRow(dir, "sess-ou", "ocr-run-ou", {
      parentRunId: "oath-upload-run-1",
      operationWorkflow: "oath-upload",
    });
    const calls: Array<{ workflow: string }> = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId) => {
        const itemIds = inputs.map((inp, i) => deriveItemId(inp, i));
        calls.push({ workflow });
        return { enqueued: itemIds.map((id) => ({ id })) };
      },
    });
    const res = await handler({
      sessionId: "sess-ou",
      runId: "ocr-run-ou",
      records: [oathRecord("10000001")],
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: true; fannedOut: Array<{ workflow: string }> };
    const workflows = body.fannedOut.map((f) => f.workflow);
    assert.ok(workflows.includes("oath-signature"), "signers fan out");
    assert.equal(
      workflows.includes("oath-upload"),
      false,
      "no NEW oath-upload row — the born-at-upload task files the ticket",
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls.find((c) => c.workflow === "oath-upload"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve for a standalone oath OCR run is REJECTED (approval ≡ delegation; legacy fan-out removed 2026-06-11)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-op-standalone-"));
  try {
    // No operationWorkflow / no parentRunId → standalone OCR-hub upload. The
    // UI never offers Approve for standalone runs; the route now fails loud
    // instead of silently fanning out the legacy both-targets rows.
    seedOathOcrRow(dir, "sess-std", "ocr-run-std");

    const calls: Array<{ workflow: string }> = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId) => {
        const itemIds = inputs.map((inp, i) => deriveItemId(inp, i));
        calls.push({ workflow });
        return { enqueued: itemIds.map((id) => ({ id })) };
      },
    });

    const res = await handler({
      sessionId: "sess-std",
      runId: "ocr-run-std",
      records: [oathRecord("10000001")],
    });
    assert.equal(res.status, 400);
    const body = res.body as { ok: false; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /[Ss]tandalone OCR runs have no approve flow/);
    assert.equal(calls.length, 0, "nothing is enqueued for a rejected standalone approve");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
