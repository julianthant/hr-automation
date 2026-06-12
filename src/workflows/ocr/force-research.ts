/**
 * Drops resolved fields on selected records, re-fans-out eid-lookup, watches
 * for completions, patches the OCR row's records progressively.
 */
import { emitTrackerRow, dateLocal } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/delegation/watch-child-runs.js";
import { fanOutAndWatch } from "../../services/ocr/fan-out.js";
import { emitOcrReviewSnapshot } from "../../services/ocr/review-snapshot.js";
import { getFormSpec } from "../../services/ocr/forms/registry.js";
import {
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
} from "../../services/ocr/eid-lookup-results.js";
import { readQueueTitle } from "../../domain/queue-title.js";

const WORKFLOW = "ocr";

export interface ForceResearchInput {
  sessionId: string;
  runId: string;
  recordIndices: number[];
}

export interface ForceResearchOpts {
  /** Tracker directory override. Default: `.tracker`. */
  trackerDir?: string;
  // ─── Test escape hatches ──────────────────────────────
  _watchChildRunsOverride?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  _enqueueOverride?: (itemIds: string[], inputs: unknown[]) => Promise<void>;
}

export async function runForceResearch(input: ForceResearchInput, trackerDirOrOpts?: string | ForceResearchOpts): Promise<void> {
  const opts: ForceResearchOpts = typeof trackerDirOrOpts === "string"
    ? { trackerDir: trackerDirOrOpts }
    : (trackerDirOrOpts ?? {});
  const trackerDir = opts.trackerDir;

  const date = dateLocal();
  const latest = findLatestEntryForPredicate({
    workflow: WORKFLOW,
    trackerDir,
    lookbackDays: 7,
    predicate: (e) => e.id === input.sessionId && e.runId === input.runId,
  });
  if (!latest) throw new Error("OCR row not found in JSONL");
  const formType = latest.data?.formType as unknown as string | undefined;
  if (!formType) throw new Error("formType missing on OCR row");
  // Hard-reject verify rows (N4). force-research is the oath/EC re-research path:
  // it CLEARS employeeId, re-fans person-lookup by NAME, and patches via
  // `patchOcrRecordFromEidLookupOutcome` only — it never calls
  // `applyPersonLookupToVerifyRecord`, never rebuilds `checks[]`, and drops
  // `paperEmployeeId`. Running it on a verify record corrupts the completeness
  // report. The verify analogue is `verify-relookup` (re-runs ONE lookup per
  // record + rebuilds checks); the dashboard routes verify rows there. Mirror
  // verify-relookup's inverse guard (`formType !== "verify"`).
  if (formType === "verify") {
    throw new Error(
      'force-research does not apply to verify rows — use verify-relookup (per-check ↻) instead',
    );
  }
  const spec = getFormSpec(formType);
  if (!spec) throw new Error(`Unknown formType "${formType}"`);

  const records: unknown[] = JSON.parse((latest.data?.records as unknown as string) ?? "[]");
  const itemIds: string[] = [];
  const enqueueInputs: Array<{ name: string }> = [];
  // Map itemId → index into records[] for outcome patching.
  const itemIdToRecordIdx = new Map<string, number>();

  for (const idx of input.recordIndices) {
    const r = records[idx] as Record<string, unknown>;
    if (!r) continue;
    if ("employee" in r) {
      const e = r.employee as Record<string, unknown>;
      e.employeeId = "";
    } else {
      r.employeeId = "";
    }
    r.matchState = "lookup-pending";
    r.matchSource = null;
    r.matchConfidence = null;
    r.verification = null;
    r.forceResearch = true;
    const itemId = `ocr-force-${input.runId}-r${idx}`;
    itemIds.push(itemId);
    itemIdToRecordIdx.set(itemId, idx);
    const name = spec.carryForwardKey(r);
    enqueueInputs.push({ name });
  }

  emitTrackerRow(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      status: "running",
      step: "person-lookup",
      data: { records: JSON.stringify(records), archetype: "preview" },
    },
    trackerDir,
  );

  // Shared dispatch→watch→cascade-cancel pipeline (BM-1). force-research re-fans
  // person-lookup by NAME (it cleared employeeId above) and patches each outcome
  // with the name-resolution semantics. The `_enqueueOverride(itemIds, inputs)`
  // HTTP test seam maps to fanOutAndWatch's dispatch override; the cascade-cancel
  // on operator discard-abort lives in fanOutAndWatch.
  type EidLookupChildInput = { name: string };
  const { personLookupWorkflow } = await import("../person-lookup/index.js");
  const { byItemId, missingItemIds } = await fanOutAndWatch<EidLookupChildInput>({
    sessionId: input.sessionId,
    runId: input.runId,
    parentRunId: input.runId,
    trackerDir,
    date,
    child: personLookupWorkflow as never,
    children: enqueueInputs.map((inp, idx) => ({ input: inp, itemId: itemIds[idx] ?? "" })),
    timeoutMs: 30 * 60_000,
    ...(opts._enqueueOverride
      ? { dispatch: async (children) => opts._enqueueOverride!(children.map((c) => c.itemId), children.map((c) => c.input)) }
      : {}),
    ...(opts._watchChildRunsOverride ? { watch: opts._watchChildRunsOverride } : {}),
  });

  // Patch records from lookup outcomes before emitting the final state.
  for (const [itemId, outcome] of byItemId) {
    const idx = itemIdToRecordIdx.get(itemId);
    if (idx === undefined) continue;
    patchOcrRecordFromEidLookupOutcome(records, idx, outcome, "name");
  }

  // Any expected itemId that did not produce an outcome (timeout or skipped)
  // must be marked unresolved so the dashboard does not leave the record
  // stuck in `lookup-pending`. Mirrors the orchestrator's safety net.
  for (const itemId of missingItemIds) {
    const idx = itemIdToRecordIdx.get(itemId);
    if (idx === undefined) continue;
    patchOcrRecordUnresolved(
      records,
      idx,
      "eid-lookup timed out without a result",
    );
  }

  // Re-emit via the shared OCR preview-row envelope (BM-5) so the dashboard
  // resolves the row by archetype/__id/__name/parentSubject. Running → done pair.
  const parentRunId = (latest.data?.parentRunId as unknown as string | undefined) ?? latest.parentRunId;
  const parentSubject =
    readQueueTitle(latest.data) ??
    (latest.data?.parentSubject as unknown as string | undefined);
  const snapshotArgs = {
    base: { ...(latest.data ?? {}) },
    sessionId: input.sessionId,
    runId: input.runId,
    records,
    step: "awaiting-approval",
    parent: {
      ...(parentRunId ? { parentRunId } : {}),
      ...(parentSubject ? { parentSubject } : {}),
    },
    trackerDir,
  } as const;
  emitOcrReviewSnapshot({ ...snapshotArgs, status: "running" });
  emitOcrReviewSnapshot({ ...snapshotArgs, status: "done" });
}
