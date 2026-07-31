/**
 * Fan out an OnBase import member task for EVERY record of a finished
 * onbase-emergency-contact OCR session — deliberately bypassing the approval
 * gates (`selected` and the normal form-spec eligibility checks) so ALL
 * extracted people become OnBase member runs, each keyed by its extracted
 * UCPath ID + source page split out of the cached combined PDF.
 *
 *   npx tsx --env-file=.env scripts/enqueue-onbase-all-from-session.ts <ocrSessionId> [--dry-run] [--workers N]
 *
 * Members enqueue under the session's EXISTING operation coordinator
 * (parentRunId + `ob-…` root trace prefix) via the production
 * `ensureDaemonsAndEnqueue` path, reusing the canonical
 * `ocr-onbase-<ocrRunId>-r<index>` item ids so earlier failed/cancelled
 * attempts read as retried members, not duplicates. Fail-loud: a record
 * without an OnBase-importable EID aborts the whole fan-out by name.
 */
import { randomUUID, type UUID } from "node:crypto";

import { ensureDaemonsAndEnqueue } from "../src/core/daemon/client.js";
import { buildHttpPendingData } from "../src/core/daemon/enqueue-dispatch.js";
import { loadWorkflow } from "../src/core/workflow-loaders.js";
import { normalizeUcpathEmployeeId } from "../src/domain/identity/eid.js";
import { tracePrefix } from "../src/domain/queue-trace-id.js";
import { deriveRowArchetype, resolveArchetype } from "../src/domain/row-archetype.js";
import { runOptionsToDaemonFlags } from "../src/domain/run-options.js";
import { PreviewRecordSchema } from "../src/services/ocr/forms/emergency-contact.js";
import { onbaseEmergencyContactOcrFormSpec } from "../src/services/ocr/forms/onbase-emergency-contact.js";
import { buildFanOutItemIdResolver } from "../src/tracker/dashboard/ocr/approve.js";
import {
  composeFanOutMemberTraceId,
  withMemberShapeRuntimeOption,
  withRootTracePrefixRuntimeOption,
} from "../src/tracker/dashboard/ocr/fan-out-runtime-options.js";
import { findLatestEntryForPredicate } from "../src/tracker/find-latest-entry.js";
import { emitTrackerRow } from "../src/tracker/jsonl.js";
import { log } from "../src/utils/log.js";
import type { OcrApproveRecordContext } from "../src/workflows/ocr/types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sessionId = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const workersIdx = args.indexOf("--workers");
  const workers = workersIdx >= 0 ? Number(args[workersIdx + 1]) : undefined;
  if (!sessionId) {
    throw new Error(
      "usage: npx tsx --env-file=.env scripts/enqueue-onbase-all-from-session.ts <ocrSessionId> [--dry-run] [--workers N]",
    );
  }

  const row = findLatestEntryForPredicate({
    workflow: "ocr",
    lookbackDays: 7,
    predicate: (e) => e.id === sessionId && typeof e.data?.records === "string",
  });
  if (!row) {
    throw new Error(
      `no OCR row with records found for session ${sessionId} — was the OCR run completed?`,
    );
  }
  const parentRunId = row.parentRunId;
  if (!parentRunId) {
    throw new Error(
      `OCR session ${sessionId} has no operation coordinator (parentRunId) — standalone sessions cannot fan out to onbase`,
    );
  }
  const ocrRunId = row.runId;
  if (!ocrRunId) {
    throw new Error(`OCR session ${sessionId} row has no runId — cannot key member item ids`);
  }
  const data = row.data as Record<string, unknown>;
  const pdfFileId = typeof data.pdfFileId === "string" ? data.pdfFileId : "";
  if (!pdfFileId) {
    throw new Error(`OCR session ${sessionId} row has no pdfFileId — cannot resolve page images`);
  }
  const pdfOriginalName =
    typeof data.pdfOriginalName === "string" ? data.pdfOriginalName : undefined;
  const traceId = typeof data.__traceId === "string" ? data.__traceId : undefined;
  if (!traceId) {
    throw new Error(`OCR session ${sessionId} row has no __traceId — cannot brand member traces`);
  }
  const rootPrefix = tracePrefix(traceId);

  const records = PreviewRecordSchema.array().parse(JSON.parse(data.records as string));
  log.step(
    `[onbase-all] session ${sessionId} run ${ocrRunId.slice(0, 8)} — ${records.length} record(s), coordinator ${parentRunId.slice(0, 8)}, prefix ${rootPrefix}`,
  );

  const spec = onbaseEmergencyContactOcrFormSpec;
  const approveTo = spec.approveTo;
  if (!approveTo) throw new Error("onbase-emergency-contact spec has no approveTo — cannot fan out");

  const recordContext: OcrApproveRecordContext = {
    sessionId,
    runId: ocrRunId,
    parentRunId,
    pdfFileId,
    ...(pdfOriginalName ? { pdfOriginalName } : {}),
  };

  // Fail loud BEFORE any enqueue: OnBase imports are keyed by UCPath ID, so a
  // record whose extracted EID isn't importable must abort by name, not skip.
  const unusable = records
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) => !/^\d{5,}$/.test(normalizeUcpathEmployeeId(rec.employee?.employeeId ?? "")))
    .map(
      ({ rec, i }) =>
        `#${i} page ${rec.sourcePage} ${rec.employee?.name ?? "?"} (eid=${rec.employee?.employeeId ?? "none"})`,
    );
  if (unusable.length > 0) {
    throw new Error(
      `records without an OnBase-importable EID — fix or remove before fan-out:\n${unusable.join("\n")}`,
    );
  }

  const logicalInputs = records.map((rec) => {
    const base = approveTo.deriveInput(rec, recordContext);
    return dryRun ? { ...base, dryRun: true } : base;
  });
  const itemIds = records.map((rec, i) => approveTo.deriveItemId(rec, ocrRunId, i));
  const runIds: UUID[] = logicalInputs.map(() => randomUUID());
  const wrappedInputs = logicalInputs.map((input) =>
    withMemberShapeRuntimeOption(
      withRootTracePrefixRuntimeOption(input, rootPrefix),
      "operation-member",
    ),
  );
  const deriveItemId = buildFanOutItemIdResolver(logicalInputs, itemIds, "onbase");

  const wf = await loadWorkflow("onbase");
  if (!wf) throw new Error("onbase workflow could not be loaded");

  const onPreEmitPending = (
    item: unknown,
    childRunId: string,
    passedParentRunId: string | undefined,
    itemId: string,
  ): void => {
    const effectiveParent = passedParentRunId ?? parentRunId;
    const memberTraceId = composeFanOutMemberTraceId(rootPrefix, childRunId);
    const childInput =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : undefined;
    emitTrackerRow({
      workflow: wf.config.name,
      timestamp: new Date().toISOString(),
      id: itemId,
      runId: childRunId,
      status: "pending",
      data: {
        ...buildHttpPendingData(wf, item, effectiveParent),
        ...(memberTraceId ? { __traceId: memberTraceId } : {}),
        archetype: deriveRowArchetype(resolveArchetype(wf.config, item), effectiveParent, {
          memberShape: "operation-member",
        }),
      },
      parentRunId: effectiveParent,
      ...(childInput ? { input: childInput } : {}),
    });
  };

  const dispatchResult = await ensureDaemonsAndEnqueue(
    wf,
    wrappedInputs as never,
    runOptionsToDaemonFlags(workers !== undefined ? { parallelWorkers: workers } : undefined),
    {
      deriveItemId,
      runIds,
      existingTaskPolicy: "idempotent",
      parentRunId,
      onPreEmitPending,
    },
  );

  const enqueued =
    dispatchResult && "enqueued" in dispatchResult && Array.isArray(dispatchResult.enqueued)
      ? dispatchResult.enqueued.length
      : itemIds.length;
  log.success(
    `[onbase-all] enqueued ${enqueued} onbase member task(s) under coordinator ${parentRunId.slice(0, 8)}${dryRun ? " (dryRun)" : ""}`,
  );
  console.log(
    JSON.stringify(
      { ok: true, sessionId, ocrRunId, parentRunId, dryRun, recordCount: records.length, enqueued, itemIds },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
