/**
 * Drops resolved fields on selected records, re-fans-out eid-lookup, watches
 * for completions, patches the OCR row's records progressively.
 */
import { emitTrackerRow, dateLocal, type StampedData } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { watchChildRuns, type ChildOutcome } from "../../tracker/delegation/watch-child-runs.js";
import { getFormSpec } from "../../services/ocr/forms/registry.js";
import {
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
} from "../../services/ocr/eid-lookup-results.js";
import { resolveParentSubject } from "../../services/ocr/parent-subject.js";

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
    lookbackDays: 7,
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

  emitTrackerRow(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      status: "running",
      step: "eid-lookup",
      // OCR prep parent is always batch-parent.
      data: { records: JSON.stringify(records), archetype: "batch-parent" },
    },
    trackerDir,
  );

  if (opts._enqueueOverride) {
    await opts._enqueueOverride(itemIds, enqueueInputs);
  } else {
    // Contract 3 (Finding #23): route through delegateToAllImpl so parentRunId
    // stamping, archetype derivation, and child pending pre-emit share one
    // code path with the OCR orchestrator's eid-lookup fan-out. Mirrors the
    // orchestrator's shape:
    //   - `renderAs: "flat"` → stamps archetype "passive-child" so children
    //     render as `delegation-member` rows (OCR runtime policy's
    //     `utilityChildSurface: "delegation-member"`).
    //   - `fireAndForget: true` because the `watchChildRuns` call below still
    //     drives the wait — wrapping a second wait inside delegateToAllImpl
    //     would double-count.
    //   - `parentRunId: input.runId` so the OCR session row is the parent of
    //     each eid-lookup child row.
    const { delegateToAllImpl } = await import("../../core/delegate.js");
    const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
    const inputToItemId = new Map(
      enqueueInputs.map((inp, idx) => [JSON.stringify(inp), itemIds[idx] ?? ""])
    );
    type EidLookupChildInput = { name: string };
    await delegateToAllImpl<EidLookupChildInput, readonly string[]>({
      parentRunId: input.runId,
      trackerDir,
      // eidLookupCrmWorkflow's exact generic param doesn't line up with the
      // narrowed `{ name }` shape used here (it accepts a union of name-only /
      // emplId-only variants), so cast through unknown — the runtime schema
      // validates the actual shape.
      child: eidLookupCrmWorkflow as unknown as Parameters<typeof delegateToAllImpl<EidLookupChildInput, readonly string[]>>[0]["child"],
      inputs: enqueueInputs,
      renderAs: "flat",
      fireAndForget: true,
      deriveItemId: (inp: EidLookupChildInput) => inputToItemId.get(JSON.stringify(inp)) ?? "",
    });
  }

  const watchFn = opts._watchChildRunsOverride ?? watchChildRuns;
  const outcomes = await watchFn({
    workflow: "eid-lookup",
    expectedItemIds: itemIds,
    trackerDir,
    date,
    timeoutMs: 30 * 60_000,
  });

  // Patch records from lookup outcomes before emitting the final state.
  for (const outcome of outcomes) {
    const idx = itemIdToRecordIdx.get(outcome.itemId);
    if (idx === undefined) continue;
    patchOcrRecordFromEidLookupOutcome(records, idx, outcome, "name");
  }

  // Any expected itemId that did not produce an outcome (timeout or skipped)
  // must be marked unresolved so the dashboard does not leave the record
  // stuck in `lookup-pending`. Mirrors the orchestrator's safety net.
  const receivedItemIds = new Set(outcomes.map((o) => o.itemId));
  for (const itemId of itemIds) {
    if (receivedItemIds.has(itemId)) continue;
    const idx = itemIdToRecordIdx.get(itemId);
    if (idx === undefined) continue;
    patchOcrRecordUnresolved(
      records,
      idx,
      "eid-lookup timed out without a result",
    );
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
  // baseData already carries `archetype: "batch-parent"` (line above) so
  // emitTrackerRow's StampedData contract is satisfied at compile time.
  const stampedBase = baseData as StampedData;
  emitTrackerRow(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      ...(parentRunId ? { parentRunId } : {}),
      status: "running",
      step: "awaiting-approval",
      data: stampedBase,
    },
    trackerDir,
  );
  emitTrackerRow(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      ...(parentRunId ? { parentRunId } : {}),
      status: "done",
      step: "awaiting-approval",
      data: stampedBase,
    },
    trackerDir,
  );
}
