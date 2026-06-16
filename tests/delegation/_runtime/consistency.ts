import assert from "node:assert/strict";

import type { DashboardView } from "./runtime.js";

/**
 * Cross-stage invariant check for an OCR-delegated **operation** lifecycle —
 * run after EACH stage (prepare, awaiting-approval, approve fan-out, completion)
 * to pin that the operation coordinator, its delegated OCR review row, and its
 * fanned-out member rows stay mutually consistent. A miss FAILS LOUD with a
 * diff-friendly message naming the exact run/field.
 */
export interface OperationConsistencyOpts {
  /** The target workflow the operation coordinator row lives in (oath-signature / emergency-contact). */
  operationWorkflow: string;
  /** The operation coordinator run id (= the OCR run's parentRunId). */
  operationRunId: string;
  /** The delegated OCR review run id. */
  ocrRunId: string;
  /**
   * The member child runs expected under the coordinator, by workflow:
   * `{ "oath-signature": [runId, runId] }`. After prepare/awaiting-approval pass
   * an empty map (no members yet); after approve pass the claimed member runs.
   */
  expectedMembers: Record<string, ReadonlyArray<string>>;
  /** All child runs of the operation run (from `await rt.children(operationRunId)`). */
  children: ReadonlyArray<{ workflow: string; runId: string; itemId: string }>;
  /**
   * Whether the OCR review row should be terminal (`done`) at this stage. Before
   * approve it is `running step=awaiting-approval`; after approve it is `done`.
   * Default `false`.
   */
  ocrTerminal?: boolean;
}

/**
 * Assert the operation-coordinator invariants:
 *  1. The operation row exists, is `archetype:"operation"`, parents NOTHING
 *     (it is the root coordinator), and denormalizes the OCR status
 *     (`ocrStatus`/`ocrStep`/`ocrRunId`/`ocrSessionId`).
 *  2. The OCR review row is delegated under the operation (`parentRunId ===
 *     operationRunId`) and projects `preview` (needsReview while parked; done
 *     after approve).
 *  3. Every expected member row is `archetype:"operation-member"`, parented to
 *     the operation run, and carries the operation's shared trace prefix.
 *  4. The member count by workflow matches `expectedMembers` exactly, with no
 *     orphan rows (every child of the operation run is either the OCR row or an
 *     expected member).
 *  5. All rows (operation, OCR, members) share the operation's `<code>-<HHMMSS>`
 *     trace prefix.
 */
export function assertOperationConsistency(dash: DashboardView, opts: OperationConsistencyOpts): void {
  const { operationWorkflow, operationRunId, ocrRunId, expectedMembers } = opts;

  // ── 1. Operation coordinator row ──────────────────────────────────────────
  const opRow = dash.row(operationWorkflow, operationRunId);
  assert.notEqual(
    opRow.status,
    "missing",
    `[consistency] operation row missing for ${operationWorkflow}/${operationRunId}`,
  );
  assert.equal(
    opRow.archetype,
    "operation",
    `[consistency] operation row archetype must be "operation" (got "${opRow.archetype}")`,
  );
  assert.equal(
    opRow.parentRunId,
    null,
    `[consistency] operation coordinator is the root — it must have no parentRunId (got ${opRow.parentRunId})`,
  );
  for (const field of ["ocrStatus", "ocrStep", "ocrRunId", "ocrSessionId"] as const) {
    assert.ok(
      opRow.data[field] !== undefined && opRow.data[field] !== "",
      `[consistency] operation row missing denormalized OCR field data.${field}`,
    );
  }
  assert.equal(
    opRow.data.ocrRunId,
    ocrRunId,
    `[consistency] operation row data.ocrRunId must point at the delegated OCR run`,
  );
  assert.ok(opRow.data.__traceId, "[consistency] operation row carries a trace id");
  // The per-row snapshot scrubs the trace id to `<traceId>`, so prefix-equality
  // would compare placeholders. Read the RAW id off the timeline (the last
  // emitted row) so a genuine prefix MISMATCH is caught.
  const opTracePrefix = rawTracePrefix(dash, operationWorkflow, operationRunId);
  assert.ok(opTracePrefix, "[consistency] operation row has a resolvable raw trace prefix");

  // ── 2. Delegated OCR review row ───────────────────────────────────────────
  const ocrRow = dash.row("ocr", ocrRunId);
  assert.notEqual(ocrRow.status, "missing", `[consistency] OCR review row missing for ocr/${ocrRunId}`);
  assert.equal(
    ocrRow.parentRunId,
    operationRunId,
    `[consistency] OCR review row must be delegated under the operation run ` +
      `(parentRunId ${ocrRow.parentRunId} !== ${operationRunId})`,
  );
  assert.equal(
    ocrRow.archetype,
    "preview",
    `[consistency] OCR review row must project as "preview" (got "${ocrRow.archetype}")`,
  );
  if (opts.ocrTerminal) {
    assert.equal(ocrRow.status, "done", `[consistency] OCR review row must be terminal done after approval`);
  } else {
    // Parked awaiting approval → the OCR statusExtension promotes the badge to
    // "needsReview" while delegated + running.
    assert.equal(
      ocrRow.statusLabel,
      "awaiting review",
      `[consistency] parked OCR review row must show the needsReview badge (got "${ocrRow.statusLabel}")`,
    );
  }
  // OCR row composes the operation's trace prefix (raw, off the timeline).
  assert.equal(
    rawTracePrefix(dash, "ocr", ocrRunId),
    opTracePrefix,
    `[consistency] OCR review row trace prefix must match the operation's`,
  );

  // ── 3 + 4. Member rows + count + no orphans ───────────────────────────────
  // Every child of the operation run is either the OCR review row or an expected
  // member — no orphans.
  const childRuns = opts.children;
  const expectedMemberRuns = new Set<string>();
  for (const runs of Object.values(expectedMembers)) for (const r of runs) expectedMemberRuns.add(r);

  for (const child of childRuns) {
    if (child.runId === ocrRunId && child.workflow === "ocr") continue;
    assert.ok(
      expectedMemberRuns.has(child.runId),
      `[consistency] ORPHAN child run under operation: ${child.workflow}/${child.runId} ` +
        `(itemId ${child.itemId}) is neither the OCR review row nor an expected member`,
    );
  }

  for (const [workflow, runIds] of Object.entries(expectedMembers)) {
    // Member count by workflow matches exactly.
    const actual = childRuns.filter((c) => c.workflow === workflow && c.runId !== ocrRunId);
    assert.equal(
      actual.length,
      runIds.length,
      `[consistency] expected ${runIds.length} ${workflow} member(s) under the operation, ` +
        `found ${actual.length} (${actual.map((c) => c.runId).join(", ")})`,
    );
    for (const runId of runIds) {
      const row = dash.row(workflow, runId);
      assert.notEqual(row.status, "missing", `[consistency] member row missing for ${workflow}/${runId}`);
      assert.equal(
        row.archetype,
        "operation-member",
        `[consistency] member ${workflow}/${runId} must be "operation-member" (got "${row.archetype}")`,
      );
      assert.equal(
        row.parentRunId,
        operationRunId,
        `[consistency] member ${workflow}/${runId} must parent to the operation run ` +
          `(parentRunId ${row.parentRunId} !== ${operationRunId})`,
      );
      // Member shares the operation trace prefix (raw, off the timeline).
      assert.equal(
        rawTracePrefix(dash, workflow, runId),
        opTracePrefix,
        `[consistency] member ${workflow}/${runId} trace prefix must match the operation's`,
      );
    }
  }
}

/**
 * Read the RAW (unscrubbed) `<code>-<HHMMSS>` trace prefix off a run's latest
 * timeline row. The per-row snapshot scrubs the trace id to `<traceId>`, so
 * prefix-equality on snapshots would compare placeholders and never catch a
 * mismatch — the raw timeline read makes the prefix-sharing invariant real.
 */
function rawTracePrefix(dash: DashboardView, workflow: string, runId: string): string {
  const rows = dash.timeline(workflow, runId);
  const traceId = rows.at(-1)?.data?.__traceId;
  if (typeof traceId !== "string" || !traceId) return "";
  const i = traceId.lastIndexOf("-");
  return i > 0 ? traceId.slice(0, i) : traceId;
}
