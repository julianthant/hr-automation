/**
 * The separations "Run I-9 Check" result fan-back — the per-person
 * `operation-member` rows emitted back into the separations queue when the
 * (approve-less) delegated i9 OCR run completes.
 *
 * Covers the pure projection (`buildI9CheckMembers`), the emit path
 * (`emitI9CheckResultRows`), and the prepare-route wiring that fires it.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildI9CheckMembers,
  emitI9CheckResultRows,
} from "../../../../src/tracker/dashboard/ocr/i9-check-results.js";
import {
  buildOcrPrepareHandler,
  _resetSessionLockForTests,
} from "../../../../src/tracker/dashboard/ocr/index.js";
import { i9CheckResultTag } from "../../../../src/domain/separations-status.js";
import { buildWorkflowRunProjection } from "../../../../src/domain/workflow-runtime/projection.js";
import { rowFilePath, rowsDir } from "../../../../src/tracker/paths.js";
import type { I9PreviewRecord } from "../../../../src/services/ocr/forms/i9.js";

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

// ─── buildI9CheckMembers (pure) ──────────────────────────────

test("buildI9CheckMembers: a found record is done + carries the matched EID", () => {
  const members = buildI9CheckMembers([
    rec({ ucpathFound: true, matchedEmplId: "10366615", matchedName: "Jane Doe", personMatchStatus: "completed" }),
  ]);
  assert.equal(members.length, 1);
  const { logs, ...fields } = members[0];
  assert.deepEqual(fields, {
    index: 0,
    name: "Doe, Jane",
    status: "done",
    ucpathFound: "true",
    emplId: "10366615",
    matchedName: "Jane Doe",
  });
  assert.ok(logs.length > 0, "a member row must carry its own log lines");
});

test("buildI9CheckMembers: a definitive not-found record is done, NOT failed", () => {
  const members = buildI9CheckMembers([rec({ ucpathFound: false, personMatchStatus: "completed" })]);
  assert.equal(members[0].status, "done");
  assert.equal(members[0].ucpathFound, "false");
  assert.equal(members[0].emplId, undefined);
});

test("buildI9CheckMembers: an UNANSWERED check is failed with a legible error — never a silent not-found", () => {
  const members = buildI9CheckMembers([
    rec({ personMatchStatus: "failed", warnings: ["UCPath person match timed out without a result"] }),
  ]);
  assert.equal(members[0].status, "failed");
  assert.equal(members[0].ucpathFound, undefined, "an unanswered check carries NO found/not-found verdict");
  assert.equal(members[0].error, "UCPath person match timed out without a result");
});

test("buildI9CheckMembers: an unsearchable record (no SSN + no DOB) still yields a failed row", () => {
  const members = buildI9CheckMembers([
    rec({
      ssn: null,
      dateOfBirth: null,
      matchState: "unresolved",
      warnings: ["Cannot search UCPath: the I-9 needs a legible name plus a full SSN or a mm/dd/yyyy date of birth"],
    }),
  ]);
  assert.equal(members.length, 1);
  assert.equal(members[0].status, "failed");
  assert.match(members[0].error ?? "", /Cannot search UCPath/);
});

test("buildI9CheckMembers: filler pages are skipped, but an unreadable I-9 page still reports", () => {
  const members = buildI9CheckMembers([
    rec({ ucpathFound: false, personMatchStatus: "completed" }),
    // A Section 2 / list-of-documents page — expected filler, not a person.
    rec({ formKind: "unknown", lastName: null, firstName: null, name: "", ssn: null, dateOfBirth: null }),
    // An I-9-classified page whose Section 1 was unreadable — MUST still surface.
    rec({ formKind: "i9", sourcePage: 3, lastName: null, firstName: null, name: "", ssn: null, dateOfBirth: null }),
  ]);
  assert.equal(members.length, 2, "the filler page is skipped; the unreadable I-9 page is not");
  assert.deepEqual(members.map((m) => m.index), [0, 2]);
  assert.equal(members[1].status, "failed");
  assert.equal(members[1].name, "Page 3 — unreadable Section 1");
});

// ─── the found / not-found queue tag ─────────────────────────

test("i9CheckResultTag: found → success chip, not-found → warning chip, unanswered → NO chip", () => {
  assert.equal(i9CheckResultTag({ data: { ucpathFound: "true" } })?.text, "In UCPath");
  assert.equal(i9CheckResultTag({ data: { ucpathFound: "false" } })?.text, "Not in UCPath");
  assert.equal(i9CheckResultTag({ data: {} }), null);
  assert.equal(i9CheckResultTag({ data: { ucpathFound: "" } }), null);
});

// ─── emitI9CheckResultRows ───────────────────────────────────

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
      step: "person-lookup",
      data: {
        archetype: "preview",
        mode: "prepare",
        formType: "i9",
        records: JSON.stringify(records),
      },
    }) + "\n",
  );
}

test("emitI9CheckResultRows: emits one operation-member row per person under the coordinator", () => {
  const dir = mkdtempSync(join(tmpdir(), "i9-fanback-"));
  try {
    seedCompletedI9OcrRow(dir, "sess-i9", "ocr-run-1", [
      rec({ ucpathFound: true, matchedEmplId: "10366615", matchedName: "Jane Doe", personMatchStatus: "completed" }),
      rec({ lastName: "Roe", firstName: "Rick", name: "Roe, Rick", ucpathFound: false, personMatchStatus: "completed" }),
      rec({ lastName: "Poe", firstName: "Pat", name: "Poe, Pat", personMatchStatus: "failed", warnings: ["search failed"] }),
    ]);

    const summary = emitI9CheckResultRows({
      sessionId: "sess-i9",
      ocrRunId: "ocr-run-1",
      operation: { workflow: "separations", runId: "op-run-1", traceId: "se-143012-aaaa" },
      trackerDir: dir,
    });

    assert.deepEqual(summary, { emitted: 3, found: 1, notFound: 1, failed: 1 });

    const rows = readRows(dir, "separations");
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.parentRunId, "op-run-1", "members nest under the coordinator");
      assert.equal(row.data?.archetype, "operation-member");
      assert.equal(row.data?.queueRowKind, "person");
      assert.equal(row.data?.displayOnly, "true", "no daemon task backs a result row");
      assert.equal(row.step, "i9-check");
      assert.match(row.data?.__traceId ?? "", /^se-143012-/, "members compose the coordinator's trace prefix");
    }

    const found = rows.find((r) => r.data?.name === "Doe, Jane")!;
    assert.equal(found.status, "done");
    assert.equal(found.data?.ucpathFound, "true");
    assert.equal(found.data?.emplId, "10366615");

    const notFound = rows.find((r) => r.data?.name === "Roe, Rick")!;
    assert.equal(notFound.status, "done");
    assert.equal(notFound.data?.ucpathFound, "false");
    assert.equal(notFound.data?.emplId, undefined);

    const failed = rows.find((r) => r.data?.name === "Poe, Pat")!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.data?.ucpathFound, undefined);
    assert.equal(failed.error, "search failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitI9CheckResultRows: THROWS when the completed run's records are missing (never a silent empty operation)", () => {
  const dir = mkdtempSync(join(tmpdir(), "i9-fanback-miss-"));
  try {
    assert.throws(
      () =>
        emitI9CheckResultRows({
          sessionId: "sess-gone",
          ocrRunId: "ocr-run-gone",
          operation: { workflow: "separations", runId: "op-run-1", traceId: "se-143012-aaaa" },
          trackerDir: dir,
        }),
      /no records row found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── display-only rows are not retryable ─────────────────────

test("a display-only result row offers delete but NOT retry/cancel/bump", () => {
  const entry = {
    workflow: "separations",
    timestamp: new Date().toISOString(),
    id: "i9-check-sess-r0",
    runId: "member-run-1",
    parentRunId: "op-run-1",
    status: "done",
    step: "i9-check",
    data: {
      archetype: "operation-member",
      queueRowKind: "person",
      displayOnly: "true",
      name: "Doe, Jane",
      ucpathFound: "false",
    },
  };
  const projection = buildWorkflowRunProjection(entry as never, {});
  const kinds = projection.actions.filter((a) => a.enabled).map((a) => a.kind);
  assert.deepEqual(kinds, ["delete"], "retry on a task-less row would enqueue a REAL separations run");
});

// ─── prepare-route wiring ────────────────────────────────────

test("prepare: a completed delegated i9 run fans results back onto the separations coordinator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i9-prepare-"));
  _resetSessionLockForTests();
  try {
    const calls: Array<Record<string, unknown>> = [];
    const handler = buildOcrPrepareHandler({
      trackerDir: dir,
      runOrchestrator: async () => {},
      emitI9CheckResults: (args) => {
        calls.push(args as unknown as Record<string, unknown>);
        return { emitted: 2, found: 1, notFound: 1, failed: 0 };
      },
    });
    const resp = await handler({
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "i9-packet.pdf",
      formType: "i9",
      targetWorkflow: "separations",
      rosterMode: "existing",
      sessionId: "sess-i9-prep",
    });
    assert.equal(resp.status, 202);
    const body = resp.body as { ok: true; runId: string; parentRunId?: string };
    assert.ok(body.parentRunId, "the i9 check gets a separations operation coordinator");

    await new Promise((r) => setTimeout(r, 0));

    assert.equal(calls.length, 1, "the fan-back fires once the approve-less run completes");
    assert.equal(calls[0].sessionId, "sess-i9-prep");
    assert.equal(calls[0].ocrRunId, body.runId);
    assert.deepEqual((calls[0].operation as Record<string, string>).workflow, "separations");

    const coordinator = readRows(dir, "separations").at(-1)!;
    assert.equal(coordinator.status, "done", "the coordinator settles when the check completes");
    assert.equal(coordinator.data?.archetype, "operation");
    assert.equal(coordinator.data?.ocrStatus, "complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare: a FAILED fan-back drives the coordinator failed — never a silently empty operation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i9-prepare-fail-"));
  _resetSessionLockForTests();
  try {
    const handler = buildOcrPrepareHandler({
      trackerDir: dir,
      runOrchestrator: async () => {},
      emitI9CheckResults: () => {
        throw new Error("records missing");
      },
    });
    const resp = await handler({
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "i9-packet.pdf",
      formType: "i9",
      targetWorkflow: "separations",
      rosterMode: "existing",
      sessionId: "sess-i9-fail",
    });
    assert.equal(resp.status, 202);
    await new Promise((r) => setTimeout(r, 0));

    const coordinator = readRows(dir, "separations").at(-1)!;
    assert.equal(coordinator.status, "failed");
    assert.equal(coordinator.data?.ocrStatus, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Member rows carry their OWN logs (regression: empty log panel) ──────────

test("emitI9CheckResultRows: each member row gets log lines under its OWN (workflow,itemId,runId)", () => {
  const dir = mkdtempSync(join(tmpdir(), "i9-fanback-logs-"));
  try {
    seedCompletedI9OcrRow(dir, "sess-i9", "ocr-run-1", [
      rec({
        ucpathFound: true,
        matchedEmplId: "10414728",
        matchedName: "Trent Werker",
        personMatchStatus: "completed",
        personMatchTraceId: "pm-143012-bbbb",
      }),
      rec({ lastName: "Roe", firstName: "Rick", name: "Roe, Rick", ucpathFound: false, personMatchStatus: "completed" }),
    ]);

    emitI9CheckResultRows({
      sessionId: "sess-i9",
      ocrRunId: "ocr-run-1",
      operation: { workflow: "separations", runId: "op-run-1", traceId: "se-143012-aaaa" },
      trackerDir: dir,
    });

    const logPath = join(dir, "logs", `separations-${todayLocal()}.jsonl`);
    assert.ok(existsSync(logPath), "the fan-out must write a separations log file");
    const logs = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { itemId: string; runId: string; level: string; message: string });

    const rows = readRows(dir, "separations");
    for (const row of rows) {
      // The log panel reads by (workflow, tracker_date, item_id, run_id) — the
      // member's OWN runId. This is the key that matched nothing before.
      const mine = logs.filter((l) => l.itemId === row.id && l.runId === row.runId);
      assert.ok(mine.length > 0, `member row ${row.data?.name} must have logs under its own runId`);
      // The criteria the verdict rests on must be stated, not just the answer.
      assert.ok(
        mine.some((l) => l.message.includes("person search criteria")),
        "every member log states the criteria the verdict rests on",
      );
    }

    const found = rows.find((r) => r.data?.name === "Doe, Jane")!;
    const foundLogs = logs.filter((l) => l.runId === found.runId);
    assert.ok(foundLogs.some((l) => l.level === "success" && l.message.includes("10414728")));
    assert.equal(found.data?.personMatchTraceId, "pm-143012-bbbb", "row links back to the person-match child");

    const notFound = rows.find((r) => r.data?.name === "Roe, Rick")!;
    const nfLogs = logs.filter((l) => l.runId === notFound.runId);
    assert.ok(
      nfLogs.some((l) => l.level === "warn" && /NOT found in UCPath/.test(l.message)),
      "a not-found verdict is a WARNING, and says to confirm the extracted fields against the scan",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildI9CheckMembers: the SSN is NEVER written to a log line", () => {
  const members = buildI9CheckMembers([
    rec({ ssn: "123-45-6789", dateOfBirth: "04/01/1998", ucpathFound: false, personMatchStatus: "completed" }),
  ]);
  const blob = members[0].logs.map((l) => l.message).join(" | ");
  assert.ok(!blob.includes("123-45-6789") && !blob.includes("123456789"), "no SSN in logs");
  assert.ok(blob.includes("SSN supplied"), "but the log does say an SSN was searched with");
  assert.ok(blob.includes("04/01/1998"), "and states the DOB that was searched");
});

// ─── A "not found" is only as good as the data behind it ────────────────────

test("buildI9CheckMembers: a NOT-FOUND on a DISPUTED field is a loud failure, not a confident 'Not in UCPath'", () => {
  // The real 2026-07-13 failure mode: UCPath truthfully returns "no results"
  // for a misread SSN, and we reported that as "this person is not in UCPath".
  const members = buildI9CheckMembers([
    rec({
      ucpathFound: false,
      personMatchStatus: "completed",
      corroboration: "disputed",
      disputedFields: ["ssn"],
      sourcePage: 55,
    }),
  ]);
  assert.equal(members[0].status, "failed", "an untrustworthy no-match must not read as an answer");
  assert.equal(members[0].ucpathFound, undefined, "and must carry NO found/not-found chip");
  assert.match(members[0].error ?? "", /could not be trusted/);
  assert.match(members[0].error ?? "", /page 55/);
});

test("buildI9CheckMembers: a NOT-FOUND on an ILLEGIBLE field is also a failure", () => {
  const members = buildI9CheckMembers([
    rec({ ucpathFound: false, personMatchStatus: "completed", illegible: ["ssn", "dateOfBirth"] }),
  ]);
  assert.equal(members[0].status, "failed");
  assert.equal(members[0].ucpathFound, undefined);
  assert.match(members[0].error ?? "", /not legible on the scan/);
});

test("buildI9CheckMembers: a FOUND is self-validating — a dispute does NOT downgrade it", () => {
  // UCPath matched a real person; that is proof regardless of a field dispute.
  const members = buildI9CheckMembers([
    rec({
      ucpathFound: true,
      matchedEmplId: "10414728",
      personMatchStatus: "completed",
      corroboration: "disputed",
      disputedFields: ["ssn"],
    }),
  ]);
  assert.equal(members[0].status, "done");
  assert.equal(members[0].ucpathFound, "true");
  assert.equal(members[0].emplId, "10414728");
});

test("buildI9CheckMembers: a CONFIRMED not-found stays a confident, actionable 'Not in UCPath'", () => {
  const members = buildI9CheckMembers([
    rec({ ucpathFound: false, personMatchStatus: "completed", corroboration: "confirmed" }),
  ]);
  assert.equal(members[0].status, "done");
  assert.equal(members[0].ucpathFound, "false");
  const blob = members[0].logs.map((l) => l.message).join(" | ");
  assert.match(blob, /the two readings agree/);
});

test("buildI9CheckMembers: an orphan Section 2 surfaces the MISSING Section 1 page", () => {
  const members = buildI9CheckMembers([
    rec({
      formKind: "unknown",
      lastName: null,
      firstName: null,
      name: "",
      sourcePage: 24,
      section2Name: "Singh, Aryaman P",
      orphanSection2: true,
    }),
  ]);
  assert.equal(members.length, 1, "an un-checkable person must not be silently dropped");
  assert.equal(members[0].name, "Singh, Aryaman P");
  assert.equal(members[0].status, "failed");
  assert.match(members[0].error ?? "", /Section 1 page is NOT/);
});
