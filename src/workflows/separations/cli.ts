import { runWorkflow, runWorkflowBatch } from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { operatorSubjectData } from "../../domain/operator-subject.js";
import { PATHS } from "../../config.js";
import { getProcessIsolatedSessionDir } from "../../core/kernel/session.js";
import { rmSync } from "node:fs";
import { separationsWorkflow } from "./workflow.js";
import type { SeparationInput } from "./workflow.js";

/**
 * CLI adapter for single-doc separation runs. Delegates to
 * `runWorkflow(separationsWorkflow, { docId })` which owns browser launch, the
 * interleaved auth chain, step emission, screenshot-on-failure, and SIGINT
 * cleanup.
 */
export async function runSeparation(docId: string): Promise<void> {
  const sessionDir = getProcessIsolatedSessionDir(PATHS.ukgSessionSep);
  try {
    await runWorkflow(separationsWorkflow, { docId });
  } finally {
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}

/**
 * CLI adapter for multi-doc batch runs.
 *
 * Delegates to `runWorkflowBatch` sequential mode — the kernel launches
 * browsers once, runs the auth chain once, and reuses the same 4 browsers for
 * every doc, calling `session.reset(id)` between docs.
 *
 * `onPreEmitPending` emits a `pending` tracker row per docId before the first
 * step runs so the dashboard populates the queue immediately. `deriveItemId`
 * produces the docId-shaped item ID that `withTrackedWorkflow` will use.
 */
export async function runSeparationBatch(
  docIds: string[],
): Promise<{ total: number; succeeded: number; failed: number }> {
  const sessionDir = getProcessIsolatedSessionDir(PATHS.ukgSessionSep);
  const now = new Date().toISOString();
  const items = docIds.map((id) => ({ docId: id }));
  try {
    const result = await runWorkflowBatch(separationsWorkflow, items, {
      deriveItemId: (item) => (item as SeparationInput).docId,
      onPreEmitPending: (item, runId) => {
        const { docId } = item as SeparationInput;
        const subject = separationsWorkflow.config.operatorSubject?.({ docId });
        trackEvent({
          workflow: "separations",
          timestamp: now,
          id: docId,
          runId,
          status: "pending",
          data: { docId, ...operatorSubjectData(subject) },
        });
      },
    });
    return { total: result.total, succeeded: result.succeeded, failed: result.failed };
  } finally {
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}

/**
 * Daemon-mode CLI adapter. Dispatches docIds through the shared daemon queue
 * instead of launching an in-process batch: first call spawns a detached
 * daemon + pays Duo once, subsequent calls enqueue + wake alive daemons.
 *
 * See `src/core/daemon-client.ts::ensureDaemonsAndEnqueue` for flag semantics
 * and `src/workflows/separations/CLAUDE.md` ("Daemon mode") for user-facing
 * docs. `runSeparation` / `runSeparationBatch` above remain untouched so
 * tests and scripting can still run the separations workflow directly
 * without the daemon.
 */
export async function runSeparationCli(
  docIds: string[],
  options: { new?: boolean; parallel?: number } = {},
): Promise<void> {
  await buildCliAdapter<[string[]], SeparationInput>({
    workflow: separationsWorkflow,
    emptyMessage: "runSeparationCli: no doc IDs provided",
    buildInputs: (ids) => ids.map((docId) => ({ docId })),
    deriveItemId: (item) => item.docId,
    buildPendingData: (item) => ({ docId: item.docId }),
  })(docIds, options);
}
