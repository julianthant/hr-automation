import { runSeparation } from "./index.js";
import type { SessionWindows } from "./index.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { trackEvent, readEntries } from "../../tracker/jsonl.js";

const docIds = process.argv.slice(2);
if (docIds.length === 0) {
  log.error("Usage: separation <docId> [docId2] [docId3] ...");
  process.exit(1);
}

log.step(`Processing ${docIds.length} separation(s): ${docIds.join(", ")}`);

// ─── Pre-emit "pending" for all docs so the dashboard shows them immediately ───
const runIds = new Map<string, string>();
const existing = readEntries("separations");
for (const docId of docIds) {
  const priorRuns = new Set(
    existing.filter((e) => e.id === docId).map((e) => e.runId),
  );
  const runId = `${docId}#${priorRuns.size + 1}`;
  runIds.set(docId, runId);
  trackEvent({
    workflow: "separations",
    timestamp: new Date().toISOString(),
    id: docId,
    runId,
    status: "pending",
    data: {},
  });
}

// ─── Process sequentially, reusing browser windows ───
let existingWindows: SessionWindows | undefined;

for (let i = 0; i < docIds.length; i++) {
  const docId = docIds[i];
  log.step(`\n=== Document ${i + 1}/${docIds.length}: #${docId} ===`);

  try {
    const result = await runSeparation(docId, {
      keepOpen: i < docIds.length - 1, // keep open for next doc, close on last
      existingWindows,
      runId: runIds.get(docId),
    });
    existingWindows = result.windows;
    log.success(`Doc #${docId} complete: ${result.data.employeeName} (EID: ${result.data.eid})`);
  } catch (e) {
    log.error(`Doc #${docId} failed: ${errorMessage(e)}`);
    // Continue to next doc — don't abort the batch
  }
}

log.success(`\nAll ${docIds.length} separations processed.`);
