// Builds the AI-e2e fixture roster (`tests/data/e2e-fixture-roster.xlsx`) so the
// e2e Phase 0 can regenerate it deterministically WITHOUT re-running OCR to
// re-derive the names each time.
//
//   node tests/data/make-e2e-roster.mjs            # reads the identities sidecar
//   node tests/data/make-e2e-roster.mjs out.xlsx   # custom output path
//
// PII POLICY: the fixture PDFs in this dir are gitignored as "may contain PII"
// (see .gitignore), so the roster of the SAME names + EIDs is PII too. This
// script therefore bakes in NO names — it reads them from a gitignored local
// sidecar `tests/data/e2e-roster-identities.json` (also kept out of git). Both
// the sidecar and the produced .xlsx stay LOCAL; only this generator is
// committed. Sidecar shape:
//
//   [{ "eid": "10000001", "name": "Doe, Jane",
//      "street": "123 E2E Way", "city": "San Diego", "state": "CA", "zip": "92093" }, …]
//
// Identities must match the names the OCR pass extracts from the three fixture
// PDFs (multiple-oath.pdf, single-oath.pdf, emergency-contacts.pdf). If the
// sidecar is absent, bootstrap it once: run one OCR prep, read the extracted
// names from the preview, and write them here (see
// `.claude/skills/e2e-test/SKILL.md` Phase 0).
import ExcelJS from "exceljs";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sidecar = join(here, "e2e-roster-identities.json");
const out = process.argv[2] ?? join(here, "e2e-fixture-roster.xlsx");

if (!existsSync(sidecar)) {
  console.error(
    `[make-e2e-roster] missing ${sidecar}\n` +
      `Create it from the fixture PDFs' extracted names (PII — stays gitignored). ` +
      `See .claude/skills/e2e-test/SKILL.md Phase 0.`,
  );
  process.exit(1);
}

const identities = JSON.parse(readFileSync(sidecar, "utf8"));
if (!Array.isArray(identities) || identities.length === 0) {
  console.error(`[make-e2e-roster] ${sidecar} must be a non-empty array of identities`);
  process.exit(1);
}

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Roster");
ws.addRow(["UCPath ID", "Name", "Street", "City", "State", "Zip"]);
for (const p of identities) {
  ws.addRow([
    p.eid,
    p.name,
    p.street ?? "123 E2E Way",
    p.city ?? "San Diego",
    p.state ?? "CA",
    p.zip ?? "92093",
  ]);
}
await wb.xlsx.writeFile(out);
console.log("wrote", out, "rows:", identities.length);
