/**
 * Batch separation runner — processes multiple docs sequentially,
 * reusing Kuali/Kronos browser windows between docs.
 *
 * Usage: node --env-file=.env --import tsx/esm src/scripts/sep-batch.ts 3835 3840 3842
 *
 * After each doc completes, waits for Kuali form submission before proceeding.
 */
import { runSeparation } from "../workflows/separations/workflow.js";
import type { SessionWindows } from "../workflows/separations/workflow.js";
import { validateEnv } from "../utils/env.js";
import { log } from "../utils/log.js";
import { errorMessage } from "../utils/errors.js";

const docIds = process.argv.slice(2);
if (docIds.length === 0) {
  console.error("Usage: sep-batch <docId1> [docId2] ...");
  process.exit(1);
}

validateEnv();

async function waitBetweenDocs(): Promise<void> {
  log.waiting("Waiting 5 seconds before next document...");
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

async function main() {
  let windows: SessionWindows | undefined;

  for (let i = 0; i < docIds.length; i++) {
    const docId = docIds[i];
    log.step(`\n========== Doc ${i + 1}/${docIds.length}: #${docId} ==========\n`);

    try {
      const result = await runSeparation(docId, {
        keepOpen: true,
        existingWindows: windows,
      });

      windows = result.windows;
      log.success(`Doc #${docId} complete: ${result.data.employeeName} (EID: ${result.data.eid})`);

      // Brief pause before next doc
      if (i < docIds.length - 1) {
        await waitBetweenDocs();
      }
    } catch (error) {
      log.error(`Doc #${docId} failed: ${errorMessage(error)}`);
      if (!windows) break; // Can't continue without windows
    }
  }

  log.success("\n========== All documents processed ==========");
  log.step("Browsers left open for review. Close them manually when done.");
}

main().catch((e) => {
  log.error(`Batch runner failed: ${errorMessage(e)}`);
  process.exit(1);
});
