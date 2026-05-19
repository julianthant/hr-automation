/**
 * Drops resolved fields on selected records, re-fans-out eid-lookup, watches
 * for completions, patches the OCR row's records progressively.
 */
import { trackEvent, dateLocal } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { watchChildRuns, type ChildOutcome } from "../../tracker/delegation/watch-child-runs.js";
import { getFormSpec } from "../../services/ocr/forms/registry.js";
import { patchOcrRecordFromEidLookupOutcome } from "./eid-lookup-results.js";
import { resolveParentSubject } from "./orchestrator.js";

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
  _watchChildRunsOverride?: (opts: Parameters<typeof watchChildRuns>[0]) => Promise<ChildOutcome[]>;
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
    lookbackDays: 2,
    predicate: (e) => e.id === input.sessionId && e.runId === input.runId,
  });
  if (!latest) throw new Error("OCR row not found in JSONL");
  const formType = latest.data?.formType as unknown as string | undefined;
  if (!formType) throw new Error("formType missing on OCR row");
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

  trackEvent(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      status: "running",
      step: "eid-lookup",
      data: { records: JSON.stringify(records) },
    },
    trackerDir,
  );

  if (opts._enqueueOverride) {
    await opts._enqueueOverride(itemIds, enqueueInputs);
  } else {
    const { ensureDaemonsAndEnqueue } = await import("../../core/daemon/client.js");
    const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
    const inputToItemId = new Map(
      enqueueInputs.map((inp, idx) => [JSON.stringify(inp), itemIds[idx] ?? ""])
    );
    await ensureDaemonsAndEnqueue(
      eidLookupCrmWorkflow,
      enqueueInputs,
      {},
      {
        trackerDir,
        deriveItemId: (inp: unknown) => inputToItemId.get(JSON.stringify(inp)) ?? "",
      },
    );
  }

  const watchFn = opts._watchChildRunsOverride ?? watchChildRuns;
  const outcomes = await watchFn({
    workflow: "eid-lookup",
    expectedItemIds: itemIds,
    trackerDir,
    date,
    timeoutMs: 30 * 60_000,
  }).catch(() => [] as ChildOutcome[]);

  // Patch records from lookup outcomes before emitting the final state.
  for (const outcome of outcomes) {
    const idx = itemIdToRecordIdx.get(outcome.itemId);
    if (idx === undefined) continue;
    patchOcrRecordFromEidLookupOutcome(records, idx, outcome, "name");
  }

  // Mirror the orchestrator's emit shape so the dashboard can resolve the row
  // by archetype/__id/__name/parentSubject — re-stamp on every emit rather
  // than relying on whatever the latest row happened to carry.
  const parentRunId = (latest.data?.parentRunId as unknown as string | undefined) ?? latest.parentRunId;
  const originWorkflow = (latest.data?.originWorkflow as unknown as string | undefined);
  const parentSubject = resolveParentSubject({
    parentRunId,
    originWorkflow,
    trackerDir,
  });
  const baseData: Record<string, string> = {
    ...(latest.data ?? {}),
    records: JSON.stringify(records),
    mode: "prepare",
    archetype: "batch-parent",
    __id: input.sessionId,
    __name: parentSubject ?? "OCR",
    ...(parentSubject ? { parentSubject } : {}),
  };
  trackEvent(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      ...(parentRunId ? { parentRunId } : {}),
      status: "running",
      step: "awaiting-approval",
      data: baseData,
    },
    trackerDir,
  );
  trackEvent(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      ...(parentRunId ? { parentRunId } : {}),
      status: "done",
      step: "awaiting-approval",
      data: baseData,
    },
    trackerDir,
  );
}
