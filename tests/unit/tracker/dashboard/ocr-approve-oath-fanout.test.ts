import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOcrApproveHandler } from "../../../../src/tracker/dashboard/ocr/approve.js";
import { rowFilePath, rowsDir } from "../../../../src/tracker/paths.js";
import { tracePrefix, runIdFragment } from "../../../../src/domain/queue-trace-id.js";

function readEmittedRows(
  dir: string,
  workflow: string,
): Array<{ status: string; data: Record<string, unknown> }> {
  let text: string;
  try {
    text = readFileSync(rowFilePath(workflow, todayLocal(), dir), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { status: string; data: Record<string, unknown> });
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function oathRecord(opts: {
  employeeId: string;
  printedName?: string;
  selected?: boolean;
  employeeSigned?: boolean;
  dateSigned?: string;
}): Record<string, unknown> {
  return {
    formKind: "oath",
    sourcePage: 1,
    rowIndex: 0,
    printedName: opts.printedName ?? "DOE, JANE",
    employeeId: opts.employeeId,
    employeeSigned: opts.employeeSigned ?? true,
    dateSigned: opts.dateSigned ?? "4/23/26",
    documentType: "expected",
    originallyMissing: [],
    notes: [],
    matchState: "matched",
    selected: opts.selected ?? true,
    warnings: [],
  };
}

function seedOathOcrRow(
  dir: string,
  sessionId: string,
  runId: string,
  traceId?: string,
  extraData?: Record<string, unknown>,
): void {
  mkdirSync(rowsDir(dir), { recursive: true });
  appendFileSync(
    rowFilePath("ocr", todayLocal(), dir),
    JSON.stringify({
      workflow: "ocr",
      timestamp: new Date().toISOString(),
      id: sessionId,
      runId,
      // Approve requires a DELEGATED run (standalone approve was removed
      // 2026-06-11); these tests pin the fan-out MECHANICS on a delegated row.
      parentRunId: "op-parent-run",
      status: "done",
      step: "awaiting-approval",
      data: {
        formType: "oath",
        sessionId,
        pdfOriginalName: "roster.pdf",
        pdfFileId: "file-abc",
        ...(traceId ? { __traceId: traceId } : {}),
        ...extraData,
      },
    }) + "\n",
  );
}

function readRootTracePrefix(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const ro = (input as Record<string, unknown>).__runtimeOptions;
  if (!ro || typeof ro !== "object") return undefined;
  const prefix = (ro as Record<string, unknown>).rootTracePrefix;
  return typeof prefix === "string" ? prefix : undefined;
}

test("oath approve fans out BOTH targets: oath-signature signers + one oath-upload ticket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-oath-"));
  try {
    seedOathOcrRow(dir, "sess-oath", "ocr-run-oath");

    const calls: Array<{ workflow: string; inputs: unknown[]; itemIds: string[] }> = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId) => {
        const itemIds = inputs.map((inp, i) => deriveItemId(inp, i));
        calls.push({ workflow, inputs, itemIds });
        return { enqueued: itemIds.map((id) => ({ id })) };
      },
    });

    const res = await handler({
      sessionId: "sess-oath",
      runId: "ocr-run-oath",
      records: [
        oathRecord({ employeeId: "10000001", printedName: "DOE, JANE" }),
        oathRecord({ employeeId: "10000002", printedName: "ROE, RICHARD" }),
      ],
    });
    assert.equal(res.status, 200);

    // Response reflects both targets synchronously.
    const body = res.body as { ok: true; fannedOut: Array<{ workflow: string; itemId: string }> };
    const workflows = body.fannedOut.map((f) => f.workflow);
    assert.ok(workflows.includes("oath-signature"));
    assert.ok(workflows.includes("oath-upload"));

    await new Promise((r) => setTimeout(r, 300));

    const sigCall = calls.find((c) => c.workflow === "oath-signature");
    const uploadCall = calls.find((c) => c.workflow === "oath-upload");
    assert.ok(sigCall, "oath-signature should be enqueued");
    assert.ok(uploadCall, "oath-upload should be enqueued");

    // Per-record: two signer inputs with the right EIDs + itemIds.
    assert.equal(sigCall!.inputs.length, 2);
    const sigInputs = sigCall!.inputs as Array<{ emplId: string }>;
    assert.deepEqual(sigInputs.map((i) => i.emplId).sort(), ["10000001", "10000002"]);
    assert.deepEqual(sigCall!.itemIds, [
      "ocr-oath-ocr-run-oath-r0",
      "ocr-oath-ocr-run-oath-r1",
    ]);

    // Once-per-document: exactly one oath-upload input carrying the signer
    // itemIds it must wait on + the pdfFileId for path resolution.
    assert.equal(uploadCall!.inputs.length, 1);
    const docInput = uploadCall!.inputs[0] as {
      signerItemIds: string[];
      pdfFileId?: string;
      pdfOriginalName?: string;
      sessionId: string;
      mode: string;
    };
    assert.deepEqual(docInput.signerItemIds.sort(), [
      "ocr-oath-ocr-run-oath-r0",
      "ocr-oath-ocr-run-oath-r1",
    ]);
    assert.equal(docInput.pdfFileId, "file-abc");
    assert.equal(docInput.pdfOriginalName, "roster.pdf");
    assert.equal(docInput.sessionId, "sess-oath");
    assert.equal(docInput.mode, "full");
    assert.deepEqual(uploadCall!.itemIds, ["ocr-oath-upload-ocr-run-oath"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oath approve: selected-but-EID-less records are NOT enqueued and NOT waited on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-oath-skip-"));
  try {
    seedOathOcrRow(dir, "sess-skip", "ocr-run-skip");

    const calls: Array<{ workflow: string; inputs: unknown[]; itemIds: string[] }> = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId) => {
        const itemIds = inputs.map((inp, i) => deriveItemId(inp, i));
        calls.push({ workflow, inputs, itemIds });
        return { enqueued: itemIds.map((id) => ({ id })) };
      },
    });

    const res = await handler({
      sessionId: "sess-skip",
      runId: "ocr-run-skip",
      records: [
        oathRecord({ employeeId: "10000001" }),
        // selected but no valid EID → must be skipped (canFanOut === false)
        oathRecord({ employeeId: "", printedName: "NO EID PERSON" }),
      ],
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));

    const sigCall = calls.find((c) => c.workflow === "oath-signature");
    const uploadCall = calls.find((c) => c.workflow === "oath-upload");
    assert.ok(sigCall);
    assert.equal(sigCall!.inputs.length, 1, "only the EID-bearing record fans out");

    // oath-upload waits on exactly the one enqueued signer row.
    const docInput = uploadCall!.inputs[0] as { signerItemIds: string[] };
    assert.deepEqual(docInput.signerItemIds, ["ocr-oath-ocr-run-skip-r0"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oath approve applies the saved worker count as { parallel: N } to the signer fan-out, NOT the ticket", async () => {
  // The OCR row carries the operator's Automation-workers count
  // (data.parallelWorkers, stamped at prep). The approve route reads it back and
  // sizes the per-record oath-signature fan-out's daemon target — but leaves the
  // once-per-document oath-upload ticket at default (it is one row that waits for
  // the signers, not parallel work).
  const dir = mkdtempSync(join(tmpdir(), "approve-oath-workers-"));
  try {
    seedOathOcrRow(dir, "sess-w", "ocr-run-w", undefined, { parallelWorkers: "4" });

    const calls: Array<{ workflow: string; flags: unknown }> = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId, opts) => {
        const itemIds = inputs.map((inp, i) => deriveItemId(inp, i));
        calls.push({ workflow, flags: opts?.flags });
        return { enqueued: itemIds.map((id) => ({ id })) };
      },
    });

    const res = await handler({
      sessionId: "sess-w",
      runId: "ocr-run-w",
      records: [
        oathRecord({ employeeId: "10000001", printedName: "DOE, JANE" }),
        oathRecord({ employeeId: "10000002", printedName: "ROE, RICHARD" }),
      ],
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));

    const sigCall = calls.find((c) => c.workflow === "oath-signature");
    const uploadCall = calls.find((c) => c.workflow === "oath-upload");
    assert.ok(sigCall, "oath-signature enqueued");
    assert.ok(uploadCall, "oath-upload enqueued");
    assert.deepEqual(sigCall!.flags, { parallel: 4 }, "signer fan-out gets the saved worker count");
    assert.equal(uploadCall!.flags, undefined, "oath-upload ticket stays at default (one row)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oath approve passes no worker flags when the OCR row has no parallelWorkers (Auto)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-oath-auto-"));
  try {
    seedOathOcrRow(dir, "sess-auto", "ocr-run-auto");

    const calls: Array<{ workflow: string; flags: unknown }> = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId, opts) => {
        const itemIds = inputs.map((inp, i) => deriveItemId(inp, i));
        calls.push({ workflow, flags: opts?.flags });
        return { enqueued: itemIds.map((id) => ({ id })) };
      },
    });

    const res = await handler({
      sessionId: "sess-auto",
      runId: "ocr-run-auto",
      records: [oathRecord({ employeeId: "10000001", printedName: "DOE, JANE" })],
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));

    const sigCall = calls.find((c) => c.workflow === "oath-signature");
    assert.ok(sigCall, "oath-signature enqueued");
    assert.equal(sigCall!.flags, undefined, "Auto → no worker flags on the signer fan-out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oath approve stamps the OCR root's trace PREFIX as rootTracePrefix on BOTH fan-out targets", async () => {
  // Root trace-id propagation (DISPLAY-only, trace/span model): the OCR root row
  // carries the operation's `ou-…` id (branded via the oath form spec's
  // traceCode). The approve fan-out runs OUTSIDE any kernel ctx, so it reads
  // that id back off the OCR row (findFrozenTraceId) and stamps its PREFIX as
  // `rootTracePrefix` on every enqueued child's `__runtimeOptions` — the daemon
  // worker then COMPOSES `<prefix>-<ownRunId4>` on the signer rows + ticket.
  const dir = mkdtempSync(join(tmpdir(), "approve-oath-roottrace-"));
  try {
    const ROOT_ID = "ou-090553-1a57";
    const ROOT_PREFIX = tracePrefix(ROOT_ID); // "ou-090553"
    seedOathOcrRow(dir, "sess-rt", "ocr-run-rt", ROOT_ID);

    const calls: Array<{ workflow: string; inputs: unknown[] }> = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId) => {
        const itemIds = inputs.map((inp, i) => deriveItemId(inp, i));
        calls.push({ workflow, inputs });
        return { enqueued: itemIds.map((id) => ({ id })) };
      },
    });

    const res = await handler({
      sessionId: "sess-rt",
      runId: "ocr-run-rt",
      records: [
        oathRecord({ employeeId: "10000001", printedName: "DOE, JANE" }),
        oathRecord({ employeeId: "10000002", printedName: "ROE, RICHARD" }),
      ],
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));

    const sigCall = calls.find((c) => c.workflow === "oath-signature");
    const uploadCall = calls.find((c) => c.workflow === "oath-upload");
    assert.ok(sigCall, "oath-signature enqueued");
    assert.ok(uploadCall, "oath-upload enqueued");

    // Every per-record signer input carries the OCR root's PREFIX.
    for (const inp of sigCall!.inputs) {
      assert.equal(readRootTracePrefix(inp), ROOT_PREFIX, "signer input stamps the OCR root prefix");
    }
    // The once-per-document oath-upload ticket input carries it too.
    assert.equal(readRootTracePrefix(uploadCall!.inputs[0]), ROOT_PREFIX, "oath-upload input stamps the OCR root prefix");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oath approve: an operation-member pre-emit row carries a composed __traceId (ISS-004)", async () => {
  // ISS-004: the approve fan-out stamps `rootTracePrefix` on the child INPUT, so
  // the daemon composes the member `__traceId` at CLAIM. A member that is never
  // claimed (queued then cancelled-while-queued) therefore had NO trace id. The
  // pre-emit must compose it itself — identically to the daemon's claim-time
  // `buildTraceId({ rootPrefix })` (`<ocrRootPrefix>-<memberRunId4>`) — so
  // frozen-once stays consistent and a never-claimed member is still greppable.
  const dir = mkdtempSync(join(tmpdir(), "approve-oath-iss004-"));
  try {
    const ROOT_ID = "ou-090553-1a57";
    const ROOT_PREFIX = tracePrefix(ROOT_ID); // "ou-090553"
    // operationWorkflow → the per-record fan-out stamps `operation-member` rows.
    seedOathOcrRow(dir, "sess-tr", "ocr-run-tr", ROOT_ID, { operationWorkflow: "oath-signature" });

    const childRunId = "11112222-3333-4444-5555-666677778888"; // runId4 → "1111"
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId, opts) => {
        // Drive the pre-emit so the pending ROW is actually written (the prod
        // path fires onPreEmitPending per item before the enqueue).
        inputs.forEach((inp, i) => {
          opts?.onPreEmitPending?.(inp, childRunId, opts.parentRunId, deriveItemId(inp, i));
        });
        return { enqueued: inputs.map((inp, i) => ({ id: deriveItemId(inp, i) })) };
      },
    });

    const res = await handler({
      sessionId: "sess-tr",
      runId: "ocr-run-tr",
      records: [oathRecord({ employeeId: "10000001", printedName: "DOE, JANE" })],
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));

    const pending = readEmittedRows(dir, "oath-signature").filter((r) => r.status === "pending");
    assert.equal(pending.length, 1, "one operation-member pending row emitted");
    assert.equal(
      pending[0].data.__traceId,
      `${ROOT_PREFIX}-${runIdFragment(childRunId)}`,
      "member pre-emit row carries the composed <ocrRootPrefix>-<memberRunId4> trace id",
    );
    assert.equal(pending[0].data.archetype, "operation-member", "fanned-out member shape");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── buildFanOutItemIdResolver (E2E-015 / E2E-018) ───────────────────────────
// The real `ensureDaemonsAndEnqueue` strips `__runtimeOptions` via
// `splitPrefilled` and hands `deriveItemId` a structural CLONE of the logical
// input. The resolver must key by that logical JSON — the old wrapped-input
// keying missed every lookup and the constant `ocr-fallback-…-r0` fallback
// collapsed N members into one queue row.

test("buildFanOutItemIdResolver resolves cleaned structural clones to their own itemIds", async () => {
  const { buildFanOutItemIdResolver } = await import(
    "../../../../src/tracker/dashboard/ocr/approve.js"
  );
  const logicalInputs = [
    { employee: { name: "Coleman, Renee", employeeId: "10706431" }, parentSubject: "EC · 4234" },
    { employee: { name: "Sanchez, Emily", employeeId: "10664209" }, parentSubject: "EC · 4234" },
    { employee: { name: "Wu, Mandy", employeeId: "10873316" }, parentSubject: "EC · 4234" },
  ];
  const itemIds = ["ocr-ec-run1-r0", "ocr-ec-run1-r1", "ocr-ec-run1-r2"];
  const resolve = buildFanOutItemIdResolver(logicalInputs, itemIds, "emergency-contact");

  // Simulate splitPrefilled: the wrapped input loses __runtimeOptions and is
  // a NEW object (structural clone), never the original reference.
  const cleaned = logicalInputs.map((inp) => JSON.parse(JSON.stringify(inp)) as unknown);
  assert.equal(resolve(cleaned[1]), "ocr-ec-run1-r1");
  assert.equal(resolve(cleaned[0]), "ocr-ec-run1-r0");
  assert.equal(resolve(cleaned[2]), "ocr-ec-run1-r2");
});

test("buildFanOutItemIdResolver hands duplicate logical inputs their own itemIds in order", async () => {
  const { buildFanOutItemIdResolver } = await import(
    "../../../../src/tracker/dashboard/ocr/approve.js"
  );
  const twin = { emplId: "10000001", parentSubject: "Oath · 5a15" };
  const resolve = buildFanOutItemIdResolver(
    [twin, { ...twin }],
    ["ocr-oath-run1-r0", "ocr-oath-run1-r1"],
    "oath-signature",
  );
  assert.equal(resolve(JSON.parse(JSON.stringify(twin))), "ocr-oath-run1-r0");
  assert.equal(resolve(JSON.parse(JSON.stringify(twin))), "ocr-oath-run1-r1");
});

test("buildFanOutItemIdResolver fails loud on a shape mismatch instead of returning a colliding fallback", async () => {
  const { buildFanOutItemIdResolver } = await import(
    "../../../../src/tracker/dashboard/ocr/approve.js"
  );
  const resolve = buildFanOutItemIdResolver(
    [{ emplId: "10000001" }],
    ["ocr-oath-run1-r0"],
    "oath-signature",
  );
  assert.throws(
    () => resolve({ emplId: "10000001", __runtimeOptions: { rowShape: "operation-member" } }),
    /deriveItemId lookup missed/,
  );
});
