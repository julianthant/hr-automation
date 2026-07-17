/**
 * The "Run I-9 Check" member fan-out — REAL i9-check daemon tasks enqueued
 * when the (approve-less) delegated i9 OCR run completes, plus display-only
 * failed rows for never-searchable pages.
 *
 * Covers the pure planner (`buildI9CheckMemberPlan`), the enqueue path
 * (`enqueueI9CheckMemberTasks`, override seam), and the prepare-route wiring.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildI9CheckMemberPlan,
  enqueueI9CheckMemberTasks,
  type EnqueueI9CheckMemberTasksArgs,
} from "../../../../src/tracker/dashboard/ocr/i9-check-results.js";
import {
  buildOcrPrepareHandler,
  _resetSessionLockForTests,
} from "../../../../src/tracker/dashboard/ocr/index.js";
import { i9CheckResultTag } from "../../../../src/domain/i9-check-status.js";
import { buildWorkflowRunProjection } from "../../../../src/domain/workflow-runtime/projection.js";
import { rowFilePath, rowsDir } from "../../../../src/tracker/paths.js";
import type { I9PreviewRecord } from "../../../../src/services/ocr/forms/i9.js";
import type { I9CheckMemberInput } from "../../../../src/workflows/i9-check/schema.js";

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
  error?: string;
  input?: Record<string, unknown>;
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

function rec(over: Partial<I9PreviewRecord> = {}): I9PreviewRecord {
  return {
    formKind: "i9",
    sourcePage: 1,
    lastName: "Doe",
    firstName: "Jane",
    middleInitial: null,
    dateOfBirth: "04/01/1998",
    ssn: "123-45-6789",
    documentType: "expected",
    originallyMissing: [],
    illegible: [],
    corroboration: "unavailable",
    disputedFields: [],
    orphanSection2: false,
    notes: [],
    name: "Doe, Jane",
    matchState: "resolved",
    selected: true,
    warnings: [],
    checks: [],
    ...over,
  } as I9PreviewRecord;
}

const CTX = { sessionId: "sess-i9", ocrRunId: "ocr-run-1" };

// ─── buildI9CheckMemberPlan (pure) ───────────────────────────

test("plan: a searchable Section 1 becomes a REAL member task with normalized SSN + DOB", () => {
  const plan = buildI9CheckMemberPlan([rec({ hireDate: "04/25/2016", section2Page: 9 })], CTX);
  assert.equal(plan.displayFailures.length, 0);
  assert.equal(plan.tasks.length, 1);
  const task = plan.tasks[0];
  assert.equal(task.itemId, "i9-check-sess-i9-r0");
  assert.deepEqual(task.input, {
    mode: "i9-check",
    person: {
      name: "Doe, Jane",
      lastName: "Doe",
      firstName: "Jane",
      ssn: "123456789",
      dob: "04/01/1998",
      hireDate: "04/25/2016",
      sourcePage: 1,
      section2Page: 9,
    },
    ocrSessionId: "sess-i9",
    ocrRunId: "ocr-run-1",
    recordIndex: 0,
  });
  assert.equal(task.seedData.i9Check, "true");
  assert.equal(task.seedData.name, "Doe, Jane");
  assert.equal(task.seedData.section1Present, "Yes — page 1");
  assert.equal(task.seedData.section2Present, "Yes — page 9");
});

test("plan: a DISPUTED SSN is dropped from the search input (never coin-flipped)", () => {
  const plan = buildI9CheckMemberPlan(
    [rec({ corroboration: "disputed", disputedFields: ["ssn"] })],
    CTX,
  );
  assert.equal(plan.tasks[0].input.person.ssn, undefined, "disputed SSN must not be searched with");
  assert.equal(plan.tasks[0].input.person.dob, "04/01/1998", "the undisputed DOB still searches");
});

test("plan: a name with NO usable identifiers still becomes a task (name-only lookup)", () => {
  const plan = buildI9CheckMemberPlan([rec({ ssn: null, dateOfBirth: null })], CTX);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].input.person.ssn, undefined);
  assert.equal(plan.tasks[0].input.person.dob, undefined);
  assert.equal(plan.tasks[0].input.person.name, "Doe, Jane");
});

test("plan: the roster NAME-match seed rides the task input for the daemon + spreadsheet", () => {
  const plan = buildI9CheckMemberPlan(
    [
      rec({
        ppsEid: "39549",
        ppsEidPadded: "000039549",
        rosterEmplId: "10458971",
        i9SeparationDate: "8/6/2021",
        hireDate: "4/17/2018",
      }),
    ],
    CTX,
  );
  assert.deepEqual(plan.tasks[0].input.roster, {
    ppsEid: "39549",
    ppsEidPadded: "000039549",
    emplId: "10458971",
    separationDate: "8/6/2021",
  });
  assert.equal(plan.tasks[0].seedData.ppsEid, "39549");
  assert.equal(plan.tasks[0].seedData.separationDate, "8/6/2021");
  assert.equal(plan.tasks[0].seedData.i9HireDate, "4/17/2018");
});

test("plan: an unreadable Section 1 (no name at all) is a DISPLAY failure — never silently dropped", () => {
  const plan = buildI9CheckMemberPlan(
    [rec({ sourcePage: 3, lastName: null, firstName: null, name: "", ssn: null, dateOfBirth: null })],
    CTX,
  );
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.displayFailures.length, 1);
  assert.equal(plan.displayFailures[0].name, "Page 3 — unreadable Section 1");
  assert.match(plan.displayFailures[0].error, /cannot be checked/);
});

test("plan: an orphan Section 2 with a readable name gets a REAL name-only task", () => {
  const plan = buildI9CheckMemberPlan(
    [
      rec({
        formKind: "unknown",
        lastName: null,
        firstName: null,
        name: "",
        sourcePage: 24,
        section2Name: "Singh, Aryaman P",
        section2HireDate: "4/18/2016",
        orphanSection2: true,
      }),
    ],
    CTX,
  );
  assert.equal(plan.displayFailures.length, 0);
  assert.equal(plan.tasks.length, 1);
  const { person } = plan.tasks[0].input;
  assert.equal(person.name, "Singh, Aryaman P");
  assert.equal(person.orphanSection2, true);
  assert.equal(person.hireDate, "04/18/2016");
  assert.equal(person.section2Page, 24);
  assert.equal(plan.tasks[0].seedData.section1Present, "Missing");
  const blob = plan.tasks[0].logs.map((l) => l.message).join(" | ");
  assert.match(blob, /Section 1 page for this person is MISSING/);
});

test("plan: an orphan Section 2 with an UNREADABLE name is a display failure", () => {
  const plan = buildI9CheckMemberPlan(
    [
      rec({
        formKind: "unknown",
        lastName: null,
        firstName: null,
        name: "",
        sourcePage: 24,
        section2Name: null,
        orphanSection2: true,
      }),
    ],
    CTX,
  );
  assert.equal(plan.tasks.length, 0);
  assert.match(plan.displayFailures[0].error, /name line could not be read/);
});

test("plan: filler pages are skipped; indexes stay source-record-based", () => {
  const plan = buildI9CheckMemberPlan(
    [
      rec({}),
      rec({ formKind: "unknown", lastName: null, firstName: null, name: "", ssn: null, dateOfBirth: null }),
      rec({ name: "Roe, Rick", lastName: "Roe", firstName: "Rick", sourcePage: 3 }),
    ],
    CTX,
  );
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks.map((t) => t.input.recordIndex), [0, 2]);
  assert.deepEqual(plan.tasks.map((t) => t.itemId), ["i9-check-sess-i9-r0", "i9-check-sess-i9-r2"]);
});

test("plan: the SSN NEVER appears in seedData or log lines", () => {
  const plan = buildI9CheckMemberPlan([rec({})], CTX);
  const seedBlob = JSON.stringify(plan.tasks[0].seedData);
  const logBlob = plan.tasks[0].logs.map((l) => l.message).join(" | ");
  for (const blob of [seedBlob, logBlob]) {
    assert.ok(!blob.includes("123-45-6789") && !blob.includes("123456789"), "no SSN anywhere");
  }
  assert.ok(logBlob.includes("SSN supplied"), "the log says an SSN will be searched with");
  assert.ok(logBlob.includes("04/01/1998"), "and states the DOB");
});

// ─── the found / not-found queue tag ─────────────────────────

test("i9CheckResultTag: found → success chip, not-found → warning chip, unanswered → NO chip", () => {
  assert.equal(i9CheckResultTag({ data: { ucpathFound: "true" } })?.text, "In UCPath");
  assert.equal(i9CheckResultTag({ data: { ucpathFound: "false" } })?.text, "Not in UCPath");
  assert.equal(i9CheckResultTag({ data: {} }), null);
  assert.equal(i9CheckResultTag({ data: { ucpathFound: "" } }), null);
});

// ─── enqueueI9CheckMemberTasks ───────────────────────────────

function seedCompletedI9OcrRow(dir: string, sessionId: string, runId: string, records: I9PreviewRecord[]): void {
  mkdirSync(rowsDir(dir), { recursive: true });
  appendFileSync(
    rowFilePath("ocr", todayLocal(), dir),
    JSON.stringify({
      workflow: "ocr",
      timestamp: new Date().toISOString(),
      id: sessionId,
      runId,
      status: "done",
      step: "ocr",
      data: {
        archetype: "preview",
        mode: "prepare",
        formType: "i9",
        records: JSON.stringify(records),
      },
    }) + "\n",
  );
}

interface CapturedEnqueue {
  inputs: unknown[];
  flags: Record<string, unknown>;
  opts: Record<string, unknown>;
}

function buildEnqueueArgs(
  dir: string,
  captured: CapturedEnqueue[],
): EnqueueI9CheckMemberTasksArgs {
  return {
    sessionId: "sess-i9",
    ocrRunId: "ocr-run-1",
    operation: { workflow: "i9-check", runId: "op-run-1", traceId: "ic-143012-aaaa" },
    trackerDir: dir,
    ensureDaemonsAndEnqueueOverride: async (_wf, inputs, flags, opts) => {
      captured.push({ inputs, flags: flags as never, opts });
      // Mirror the real enqueue: fire onPreEmitPending once per input with the
      // pre-assigned runId + resolved itemId.
      const runIds = opts.runIds as string[];
      const deriveItemId = opts.deriveItemId as (input: unknown) => string;
      const onPreEmitPending = opts.onPreEmitPending as (
        item: unknown,
        runId: string,
        parentRunId: string | undefined,
        itemId: string,
      ) => void;
      inputs.forEach((input, i) => {
        // The real idFn strips __runtimeOptions before deriveItemId.
        const { __runtimeOptions: _r, ...cleaned } = input as Record<string, unknown>;
        const itemId = deriveItemId(cleaned);
        onPreEmitPending(input, runIds[i], opts.parentRunId as string, itemId);
      });
      return { enqueued: inputs.length };
    },
  };
}

test("enqueue: one REAL member task per person — retryable rows, no displayOnly, no input block, no SSN", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "i9-fanout-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const prevTimekeeper = process.env.TIMEKEEPER_NAME;
  process.env.TIMEKEEPER_NAME = "Julian";
  t.onTestFinished(() => {
    if (prevTimekeeper === undefined) delete process.env.TIMEKEEPER_NAME;
    else process.env.TIMEKEEPER_NAME = prevTimekeeper;
  });

  seedCompletedI9OcrRow(dir, "sess-i9", "ocr-run-1", [
    rec({}),
    rec({ lastName: "Roe", firstName: "Rick", name: "Roe, Rick", sourcePage: 2 }),
  ]);
  const captured: CapturedEnqueue[] = [];

  const summary = await enqueueI9CheckMemberTasks(buildEnqueueArgs(dir, captured));
  assert.deepEqual(summary, { enqueued: 2, displayFailed: 0 });

  // The enqueue call: wrapped inputs carry the runtime options channel.
  assert.equal(captured.length, 1);
  const wrapped = captured[0].inputs as Array<Record<string, unknown>>;
  assert.equal(wrapped.length, 2);
  for (const input of wrapped) {
    const runtime = input.__runtimeOptions as Record<string, unknown>;
    assert.equal(runtime.rowShape, "operation-member");
    assert.equal(runtime.rootTracePrefix, "ic-143012");
    assert.equal((input as { mode?: string }).mode, "i9-check");
  }
  assert.equal(captured[0].opts.existingTaskPolicy, "idempotent");
  assert.equal(captured[0].opts.parentRunId, "op-run-1");

  // The pre-emitted pending rows.
  const rows = readRows(dir, "i9-check");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, "pending");
    assert.equal(row.parentRunId, "op-run-1");
    assert.equal(row.data?.archetype, "operation-member");
    assert.equal(row.data?.queueRowKind, "person");
    assert.equal(row.data?.i9Check, "true");
    assert.equal(row.data?.displayOnly, undefined, "a REAL task row is never display-only");
    assert.equal(row.input, undefined, "no input block — SQLite original_input_json is the replay authority");
    assert.match(row.data?.__traceId ?? "", /^ic-143012-/, "members compose the coordinator's trace prefix");
    const blob = JSON.stringify(row);
    assert.ok(!blob.includes("123-45-6789") && !blob.includes("123456789"), "no SSN on the JSONL row");
  }

  // Each pending member row carries its OCR-provenance logs under its own runId.
  const logPath = join(dir, "logs", `i9-check-${todayLocal()}.jsonl`);
  assert.ok(existsSync(logPath));
  const logs = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { itemId: string; runId: string; message: string });
  for (const row of rows) {
    const mine = logs.filter((l) => l.itemId === row.id && l.runId === row.runId);
    assert.ok(mine.length > 0, `member ${row.data?.name} must log under its own runId`);
    assert.ok(
      mine.some((l) => l.message.includes("UCPath search criteria")),
      "the criteria the verdict will rest on are stated up front",
    );
  }
});

test("enqueue: unsearchable pages become display-only FAILED rows beside the real tasks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "i9-fanout-mixed-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const prevTimekeeper = process.env.TIMEKEEPER_NAME;
  process.env.TIMEKEEPER_NAME = "Julian";
  t.onTestFinished(() => {
    if (prevTimekeeper === undefined) delete process.env.TIMEKEEPER_NAME;
    else process.env.TIMEKEEPER_NAME = prevTimekeeper;
  });

  seedCompletedI9OcrRow(dir, "sess-i9", "ocr-run-1", [
    rec({}),
    rec({ sourcePage: 5, lastName: null, firstName: null, name: "", ssn: null, dateOfBirth: null }),
  ]);
  const captured: CapturedEnqueue[] = [];
  const summary = await enqueueI9CheckMemberTasks(buildEnqueueArgs(dir, captured));
  assert.deepEqual(summary, { enqueued: 1, displayFailed: 1 });

  const rows = readRows(dir, "i9-check");
  const failedRow = rows.find((r) => r.status === "failed")!;
  assert.equal(failedRow.data?.displayOnly, "true");
  assert.equal(failedRow.step, "i9-check");
  assert.match(failedRow.error ?? "", /cannot be checked/);
});

test("enqueue: THROWS when the completed run's records are missing (never a silent empty operation)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "i9-fanout-miss-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      enqueueI9CheckMemberTasks({
        sessionId: "sess-gone",
        ocrRunId: "ocr-run-gone",
        operation: { workflow: "i9-check", runId: "op-run-1", traceId: "ic-143012-aaaa" },
        trackerDir: dir,
      }),
    /no records row found/,
  );
});

test("enqueue: a missing TIMEKEEPER_NAME fails the fan-out loudly BEFORE any enqueue", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "i9-fanout-tk-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const prevTimekeeper = process.env.TIMEKEEPER_NAME;
  delete process.env.TIMEKEEPER_NAME;
  t.onTestFinished(() => {
    if (prevTimekeeper !== undefined) process.env.TIMEKEEPER_NAME = prevTimekeeper;
  });

  seedCompletedI9OcrRow(dir, "sess-i9", "ocr-run-1", [rec({})]);
  const captured: CapturedEnqueue[] = [];
  await assert.rejects(
    () => enqueueI9CheckMemberTasks(buildEnqueueArgs(dir, captured)),
    /TIMEKEEPER_NAME/,
  );
  assert.equal(captured.length, 0, "nothing may be enqueued without the reviewer identity");
});

// ─── display-only rows are not retryable ─────────────────────

test("a display-only failure row offers delete but NOT retry/cancel/bump", () => {
  const entry = {
    workflow: "i9-check",
    timestamp: new Date().toISOString(),
    id: "i9-check-sess-r0",
    runId: "member-run-1",
    parentRunId: "op-run-1",
    status: "failed",
    step: "i9-check",
    data: {
      archetype: "operation-member",
      queueRowKind: "person",
      displayOnly: "true",
      name: "Page 5 — unreadable Section 1",
    },
  };
  const projection = buildWorkflowRunProjection(entry as never, {});
  const kinds = projection.actions.filter((a) => a.enabled).map((a) => a.kind);
  assert.deepEqual(kinds, ["delete"], "retry on a task-less row would enqueue a run that never existed");
});

// ─── prepare-route wiring ────────────────────────────────────

test("prepare: a completed delegated i9 run enqueues member tasks; the coordinator stays RUNNING for the rollup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i9-prepare-"));
  _resetSessionLockForTests();
  try {
    const calls: Array<Record<string, unknown>> = [];
    const handler = buildOcrPrepareHandler({
      trackerDir: dir,
      runOrchestrator: async () => {},
      enqueueI9CheckMemberTasks: async (args) => {
        calls.push(args as unknown as Record<string, unknown>);
        return { enqueued: 2, displayFailed: 0 };
      },
    });
    const resp = await handler({
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "i9-packet.pdf",
      formType: "i9",
      targetWorkflow: "i9-check",
      rosterMode: "existing",
      sessionId: "sess-i9-prep",
    });
    assert.equal(resp.status, 202);
    const body = resp.body as { ok: true; runId: string; parentRunId?: string };
    assert.ok(body.parentRunId, "the i9 check gets an i9-check operation coordinator");

    await new Promise((r) => setTimeout(r, 0));

    assert.equal(calls.length, 1, "the fan-out fires once the approve-less run completes");
    assert.equal(calls[0].sessionId, "sess-i9-prep");
    assert.equal(calls[0].ocrRunId, body.runId);
    assert.deepEqual((calls[0].operation as Record<string, string>).workflow, "i9-check");

    const coordinator = readRows(dir, "i9-check").at(-1)!;
    assert.equal(
      coordinator.status,
      "running",
      "the coordinator must NOT settle at enqueue — the members-terminal rollup completes it",
    );
    assert.equal(coordinator.data?.archetype, "operation");
    assert.equal(coordinator.data?.ocrStatus, "members-queued");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare: a FAILED fan-out drives the coordinator failed — never a silently empty operation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i9-prepare-fail-"));
  _resetSessionLockForTests();
  try {
    const handler = buildOcrPrepareHandler({
      trackerDir: dir,
      runOrchestrator: async () => {},
      enqueueI9CheckMemberTasks: async () => {
        throw new Error("records missing");
      },
    });
    const resp = await handler({
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "i9-packet.pdf",
      formType: "i9",
      targetWorkflow: "i9-check",
      rosterMode: "existing",
      sessionId: "sess-i9-fail",
    });
    assert.equal(resp.status, 202);
    await new Promise((r) => setTimeout(r, 0));

    const coordinator = readRows(dir, "i9-check").at(-1)!;
    assert.equal(coordinator.status, "failed");
    assert.equal(coordinator.data?.ocrStatus, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── input round-trip sanity ─────────────────────────────────

test("plan inputs parse through the i9-check workflow schema — and NEVER through separations", async () => {
  const { i9CheckWorkflow } = await import("../../../../src/workflows/i9-check/workflow.js");
  const { separationsWorkflow } = await import("../../../../src/workflows/separations/workflow.js");
  const plan = buildI9CheckMemberPlan([rec({})], CTX);
  const parsed = i9CheckWorkflow.config.schema.parse(plan.tasks[0].input) as I9CheckMemberInput;
  assert.equal(parsed.mode, "i9-check");
  assert.equal(parsed.person.name, "Doe, Jane");
  // Post-split safety: the separations (termination) schema must REJECT an
  // i9-check payload outright — a replay can never become a termination.
  assert.throws(() => separationsWorkflow.config.schema.parse(plan.tasks[0].input));
});
