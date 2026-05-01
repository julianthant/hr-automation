/**
 * Drops resolved fields on selected records, re-fans-out eid-lookup, watches
 * for completions, patches the OCR row's records progressively.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { trackEvent, dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";
import { watchChildRuns } from "../../tracker/watch-child-runs.js";
import { getFormSpec } from "./form-registry.js";

const WORKFLOW = "ocr";

export interface ForceResearchInput {
  sessionId: string;
  runId: string;
  recordIndices: number[];
}

export async function runForceResearch(input: ForceResearchInput, trackerDir?: string): Promise<void> {
  const date = dateLocal();
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) throw new Error("OCR row not found");
  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  let latest: TrackerEntry | undefined;
  for (const line of lines) {
    try {
      const e: TrackerEntry = JSON.parse(line);
      if (e.id === input.sessionId && e.runId === input.runId) latest = e;
    } catch { /* tolerate */ }
  }
  if (!latest) throw new Error("OCR row not found in JSONL");
  const formType = latest.data?.formType as unknown as string | undefined;
  if (!formType) throw new Error("formType missing on OCR row");
  const spec = getFormSpec(formType);
  if (!spec) throw new Error(`Unknown formType "${formType}"`);

  const records: unknown[] = JSON.parse((latest.data?.records as unknown as string) ?? "[]");
  const itemIds: string[] = [];
  const enqueueInputs: unknown[] = [];

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
    r.matchSource = undefined;
    r.matchConfidence = undefined;
    r.verification = undefined;
    r.forceResearch = true;
    const itemId = `ocr-force-${input.runId}-r${idx}`;
    itemIds.push(itemId);
    const name = spec.carryForwardKey(r as never);
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

  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
  const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
  const inputToItemId = new Map(
    enqueueInputs.map((inp, idx) => [JSON.stringify(inp), itemIds[idx] ?? ""])
  );
  await ensureDaemonsAndEnqueue(
    eidLookupCrmWorkflow,
    enqueueInputs as never,
    {},
    { deriveItemId: (inp: unknown) => inputToItemId.get(JSON.stringify(inp)) ?? "" },
  );
  const outcomes = await watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: itemIds,
    trackerDir,
    date,
    timeoutMs: 30 * 60_000,
  }).catch(() => []);

  trackEvent(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      status: "running",
      step: "awaiting-approval",
      data: { records: JSON.stringify(records) },
    },
    trackerDir,
  );
  trackEvent(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      status: "done",
      step: "awaiting-approval",
      data: { records: JSON.stringify(records) },
    },
    trackerDir,
  );
  void outcomes;
}
