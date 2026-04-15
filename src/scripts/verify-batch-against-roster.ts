/**
 * Standalone CLI: verify a batch YAML against a local roster file.
 *
 * Usage:
 *   tsx --env-file=.env src/scripts/verify-batch-against-roster.ts \
 *       <batchYaml> <rosterXlsxOrCsv>
 *
 * Reports EIDs not found in the roster, name mismatches, and tries to
 * suggest the correct EID for missing/mismatched records by fuzzy name match.
 */
import { loadBatch } from "../workflows/emergency-contact/schema.js";
import {
  verifyBatchAgainstRoster,
  loadRosterIndex,
  namesMatch,
  normalizeName,
} from "../utils/roster-verify.js";
import { log } from "../utils/log.js";

const [yamlPath, rosterPath] = process.argv.slice(2);
if (!yamlPath || !rosterPath) {
  console.error("Usage: verify-batch-against-roster <batchYaml> <rosterXlsxOrCsv>");
  process.exit(1);
}

async function main() {
  const batch = loadBatch(yamlPath);
  const result = await verifyBatchAgainstRoster(batch, rosterPath);
  const rosterIndex = await loadRosterIndex(rosterPath);

  log.step(`Roster: ${rosterIndex.length} rows | Batch: ${batch.records.length} records`);
  log.step(`Matched: ${result.matched}/${batch.records.length}`);
  log.step(`Name mismatches: ${result.mismatched.length}`);
  log.step(`EID not in roster: ${result.missing.length}`);
  console.log("");

  if (result.mismatched.length > 0) {
    console.log("── Name mismatches ────────────────────────────────");
    for (const m of result.mismatched) {
      console.log(`  page ${m.sourcePage}  EID ${m.emplId}`);
      console.log(`    batch:  ${m.batchName}`);
      console.log(`    roster: ${m.rosterName}`);
    }
    console.log("");
  }

  if (result.missing.length > 0) {
    console.log("── EIDs not in roster (likely my OCR mistake) ─────");
    for (const m of result.missing) {
      console.log(`  page ${m.sourcePage}  EID ${m.emplId}  batch name="${m.batchName}"`);

      // Suggest fixes: find roster rows whose names match the batch name
      const suggestions = rosterIndex
        .filter((r) => r.name && namesMatch(r.name, m.batchName))
        .slice(0, 3);
      if (suggestions.length > 0) {
        for (const s of suggestions) {
          console.log(`    suggest: EID ${s.emplId}  "${s.name}"`);
        }
      } else {
        // Fuzzier: any roster row sharing any name word with the batch
        const batchWords = new Set(
          normalizeName(m.batchName).split(" ").filter((w) => w.length >= 3),
        );
        const fuzzy = rosterIndex
          .filter((r) => {
            const rw = normalizeName(r.name).split(" ").filter((w) => w.length >= 3);
            return rw.some((w) => batchWords.has(w));
          })
          .slice(0, 3);
        if (fuzzy.length > 0) {
          for (const s of fuzzy) {
            console.log(`    fuzzy: EID ${s.emplId}  "${s.name}"`);
          }
        } else {
          console.log("    (no name suggestions)");
        }
      }
    }
    console.log("");
  }

  if (result.mismatched.length === 0 && result.missing.length === 0) {
    log.success("All records match the roster.");
  } else {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
