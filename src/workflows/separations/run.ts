import { runSeparation } from "./index.js";
import type { SessionWindows } from "./index.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";

const docIds = process.argv.slice(2);
if (docIds.length === 0) {
  docIds.push("3508");
}

log.step(`Processing ${docIds.length} separation(s): ${docIds.join(", ")}`);

let existingWindows: SessionWindows | undefined;

for (let i = 0; i < docIds.length; i++) {
  const docId = docIds[i];
  log.step(`\n=== Document ${i + 1}/${docIds.length}: #${docId} ===`);

  try {
    const result = await runSeparation(docId, {
      keepOpen: true,
      existingWindows,
    });
    existingWindows = result.windows;
    log.success(`Doc #${docId} complete: ${result.data.employeeName} (EID: ${result.data.eid})`);
  } catch (e) {
    log.error(`Doc #${docId} failed: ${errorMessage(e)}`);
  }
}

log.success(`\nAll ${docIds.length} separations processed.`);
