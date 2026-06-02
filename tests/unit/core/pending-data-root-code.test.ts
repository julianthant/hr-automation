import { test } from "vitest";
import assert from "node:assert/strict";
import { z } from "zod";
import { buildPendingTrackerData } from "../../../src/core/pending-data.js";
import { defineWorkflow } from "../../../src/core/index.js";

/**
 * Trace-id provenance: a delegated child's `data.__traceId` is prefixed with
 * the ROOT/originating workflow's `code` (threaded as `rootCode`), while a
 * root row carries its own workflow `code`. Pins the consumption point at
 * `pending-data.ts` (`code: opts.rootCode ?? wf.code`).
 *
 * Format reminder: `<code>-<HHMMSS>-<runId4>` (see queue-trace-id.ts).
 */

const childWorkflow = defineWorkflow({
  name: "trace-child-test",
  code: "pl",
  inputSubject: "eid",
  systems: [],
  steps: ["done"] as const,
  schema: z.object({ emplId: z.string() }),
  operatorSubject: (input) => ({ kind: "eid", label: input.emplId }),
  handler: async () => {},
});

const FIXED_AT = new Date("2026-05-30T14:30:12.000Z");

test("buildPendingTrackerData stamps a delegated child's trace id with the root code", () => {
  const data = buildPendingTrackerData({
    workflow: childWorkflow,
    input: { emplId: "10000050" },
    parentRunId: "parent-run-1",
    useInitialTrackerSeed: true,
    nameIdStamp: "always-on-seed",
    runId: "abcd-1234-5678",
    rootCode: "os", // originating workflow = oath-signature
    at: FIXED_AT,
  });

  // Root (oath-signature) code prefix, NOT the child's own "pl".
  assert.match(data.__traceId, /^os-\d{6}-abcd$/);
});

test("buildPendingTrackerData falls back to the workflow's own code for a root row", () => {
  const data = buildPendingTrackerData({
    workflow: childWorkflow,
    input: { emplId: "10000050" },
    useInitialTrackerSeed: true,
    nameIdStamp: "always-on-seed",
    runId: "abcd-1234-5678",
    // No rootCode — this is a top-level run, so it uses its own code.
    at: FIXED_AT,
  });

  assert.match(data.__traceId, /^pl-\d{6}-abcd$/);
});

test("buildPendingTrackerData omits the trace id entirely when no runId is supplied", () => {
  const data = buildPendingTrackerData({
    workflow: childWorkflow,
    input: { emplId: "10000050" },
    useInitialTrackerSeed: true,
    nameIdStamp: "always-on-seed",
    rootCode: "os",
    at: FIXED_AT,
  });

  assert.equal(data.__traceId, undefined);
});

test("buildPendingTrackerData reuses a pre-frozen traceId verbatim instead of recomputing", () => {
  // A daemon worker re-emit passes the trace id frozen on the run's first
  // pending row (stamped seconds earlier at HTTP enqueue). It must reuse that
  // id, not mint a fresh one off `runId`+`at` — otherwise the same run shows
  // two different ids and the dashboard's latest-row-wins collapse flickers.
  const frozen = "os-143012-abcd";
  const data = buildPendingTrackerData({
    workflow: childWorkflow,
    input: { emplId: "10000050" },
    useInitialTrackerSeed: true,
    nameIdStamp: "always-on-seed",
    runId: "abcd-1234-5678",
    rootCode: "os",
    at: new Date("2026-05-30T14:31:45.000Z"), // 93s later — would drift the compute
    traceId: frozen,
  });

  assert.equal(data.__traceId, frozen);
});

test("buildPendingTrackerData stamps an inherited ROOT trace id verbatim, ignoring rootCode + runId compute", () => {
  // Root trace-id propagation: a delegated child of an oath operation inherits
  // the OCR root's full `ou-...` id. The `traceId` opt (fed `rootTraceId` by
  // delegate.ts) must win over BOTH the child's runId/at compute AND any
  // rootCode — every descendant shows the one root id, not a per-child recompute.
  const rootId = "ou-090553-1a57";
  const data = buildPendingTrackerData({
    workflow: childWorkflow,
    input: { emplId: "10000050" },
    parentRunId: "ocr-root-run",
    useInitialTrackerSeed: true,
    nameIdStamp: "always-on-seed",
    runId: "zzzz-9999-0000", // would compute `pl-...-zzzz` if the compute ran
    rootCode: "os", // would prefix `os-...` if rootCode won
    at: FIXED_AT,
    traceId: rootId,
  });

  assert.equal(data.__traceId, rootId);
});
