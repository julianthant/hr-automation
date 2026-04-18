/**
 * Batch separation runner — processes multiple docs sequentially,
 * reusing Kuali/Kronos browser windows between docs via the kernel's
 * `runWorkflowBatch` sequential mode.
 *
 * Usage: node --env-file=.env --import tsx/esm src/scripts/sep-batch.ts 3835 3840 3842
 *
 * Equivalent to `hr-auto separation <ids...>` in batch mode; kept as a dev
 * script for direct invocation without Commander.
 */
import { runSeparationBatch } from "../workflows/separations/workflow.js";
import { validateEnv } from "../utils/env.js";
import { log } from "../utils/log.js";
import { errorMessage } from "../utils/errors.js";

const docIds = process.argv.slice(2);
if (docIds.length === 0) {
  console.error("Usage: sep-batch <docId1> [docId2] ...");
  process.exit(1);
}

validateEnv();

async function main() {
  log.step(`\n========== Batch: ${docIds.length} docs — ${docIds.join(", ")} ==========\n`);
  const result = await runSeparationBatch(docIds);
  log.success(`\n========== Batch complete: ${result.succeeded}/${result.total} succeeded ==========`);
  if (result.failed > 0) process.exit(1);
}

main().catch((e) => {
  log.error(`Batch runner failed: ${errorMessage(e)}`);
  process.exit(1);
});
