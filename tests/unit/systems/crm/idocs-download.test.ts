import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PATHS } from "../../../../src/config.js";
import {
  buildCrmDocumentDownloadPath,
  onboardingDateFolder,
  buildCrmDocumentFolderName,
  sanitizeOnboardingFolderName,
  parseCrmDocumentFilename,
  sanitizeCrmDocumentFilename,
  isCrmPdfResponse,
  DEFAULT_CRM_DOC_INDICES,
  resolveDefaultCrmDocIndices,
  defaultCrmDocumentName,
  CRM_DOC_DEFAULT_NAMES,
} from "../../../../src/systems/crm/idocs-download.js";

test("DEFAULT_CRM_DOC_INDICES downloads Doc 1 and Doc 3", () => {
  assert.deepEqual(DEFAULT_CRM_DOC_INDICES, [0, 2]);
});

test("resolveDefaultCrmDocIndices returns [0, 2] when totalDocs is 9", () => {
  assert.deepEqual(resolveDefaultCrmDocIndices(9), [0, 2]);
});

test("resolveDefaultCrmDocIndices omits EE Data Gathering Form (returns [0]) when totalDocs is 5", () => {
  assert.deepEqual(resolveDefaultCrmDocIndices(5), [0]);
});

test("resolveDefaultCrmDocIndices only downloads EE Data Gathering Form when totalDocs is 9", () => {
  assert.deepEqual(resolveDefaultCrmDocIndices(1), [0]);
  assert.deepEqual(resolveDefaultCrmDocIndices(3), [0]);
  assert.deepEqual(resolveDefaultCrmDocIndices(5), [0]);
  assert.deepEqual(resolveDefaultCrmDocIndices(8), [0]);
  assert.deepEqual(resolveDefaultCrmDocIndices(9), [0, 2]);
  assert.deepEqual(resolveDefaultCrmDocIndices(10), [0]);
});

test("resolveDefaultCrmDocIndices falls back to DEFAULT_CRM_DOC_INDICES when totalDocs is undefined", () => {
  assert.deepEqual(resolveDefaultCrmDocIndices(undefined), [0, 2]);
  assert.deepEqual(resolveDefaultCrmDocIndices(), [0, 2]);
});

test("defaultCrmDocumentName names doc 1 and doc 3 by their known identity", () => {
  assert.equal(defaultCrmDocumentName(0), "Signed Offer Letter.pdf");
  assert.equal(defaultCrmDocumentName(2), "EE Data Gathering Form.pdf");
});

test("defaultCrmDocumentName falls back to document-N for unknown indices", () => {
  assert.equal(defaultCrmDocumentName(1), "document-2.pdf");
  assert.equal(defaultCrmDocumentName(4), "document-5.pdf");
});

test("defaultCrmDocumentName feeds parse/sanitize as a clean fallback", () => {
  // No Content-Disposition → the position default survives sanitization intact,
  // spaces and all, so the saved file reads as its known identity.
  const fallback = defaultCrmDocumentName(0);
  assert.equal(
    sanitizeCrmDocumentFilename(parseCrmDocumentFilename(null, fallback), fallback),
    "Signed Offer Letter.pdf",
  );
});

test("buildCrmDocumentDownloadPath lands under data/onboarding/<YYYY-MM-DD>/ (today's local date) by default", () => {
  const today = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  assert.equal(onboardingDateFolder(today), stamp);
  assert.equal(
    buildCrmDocumentDownloadPath({ firstName: "Jane", lastName: "Doe", middleName: "A" }),
    join(PATHS.onboardingDocsDir, stamp, "Person 905 A. EID"),
  );
  // An explicit date addresses that day's folder (no zip, plain folder).
  assert.equal(
    buildCrmDocumentDownloadPath({ firstName: "Jane", lastName: "Doe" }, { date: new Date(2026, 7, 18) }),
    join(PATHS.onboardingDocsDir, "2026-08-18", "Person 905 EID"),
  );
  assert.match(PATHS.onboardingDocsDir, /data[/\\]onboarding$/);
});

test("buildCrmDocumentFolderName: Last, First MiddleInitial. EID (no lived name)", () => {
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Jane", lastName: "Doe", middleName: "A" }),
    "Person 905 A. EID",
  );
});

test("buildCrmDocumentFolderName inserts the lived first name parenthetically and middle initial with dot", () => {
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "John", lastName: "Smith", middleName: "Mepafic", livedName: "Jofipe" }),
    "Smith, John (Jofipe) M. EID",
  );
});

test("buildCrmDocumentFolderName omits absent/blank middle and lived name", () => {
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Aen", lastName: "Lokuluwu", middleName: "", livedName: "  " }),
    "Lokuluwu, Aen EID",
  );
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Aen", lastName: "Lokuluwu" }),
    "Lokuluwu, Aen EID",
  );
});

test("buildCrmDocumentFolderName lived name without middle", () => {
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Ravuti", lastName: "Roe", livedName: "Bob" }),
    "Roe, Ravuti (Bob) EID",
  );
});

test("buildCrmDocumentFolderName splits compound firstName into first and middle when middleName is absent", () => {
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Hukug Hupefo", lastName: "Zine", livedName: "Hukug Hupefo Zine" }),
    "Zine, Hukug H. EID",
  );
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Vatudake Zuwilo", lastName: "Yuc", livedName: "Lefaz Yuc" }),
    "Yuc, Vatudake (Lefaz) Z. EID",
  );
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Pitozavi Yepote", lastName: "Citi", livedName: "Pitozavi Yepote Citi" }),
    "Citi, Pitozavi Y. EID",
  );
});

test("sanitizeOnboardingFolderName drops path separators, keeps name punctuation", () => {
  // Apostrophes / commas / parens survive; a stray slash does not become a subdir.
  assert.equal(sanitizeOnboardingFolderName("O'Bowom, Sean (Seanie) EID"), "O'Bowom, Sean (Seanie) EID");
  assert.equal(sanitizeOnboardingFolderName("De/Vavot, Aore EID"), "DeVavot, Aore EID");
  assert.equal(sanitizeOnboardingFolderName("A:B|C? EID"), "ABC EID");
});

test("parseCrmDocumentFilename handles RFC filename header", () => {
  assert.equal(
    parseCrmDocumentFilename('inline; filename="Offer%20Letter.pdf"', "fallback.pdf"),
    "Offer Letter.pdf",
  );
});

test("parseCrmDocumentFilename handles quoted semicolons", () => {
  assert.equal(
    parseCrmDocumentFilename('attachment; filename="Offer; Letter.pdf"; size=123', "fallback.pdf"),
    "Offer; Letter.pdf",
  );
});

test("parseCrmDocumentFilename prefers encoded filename star values", () => {
  assert.equal(
    parseCrmDocumentFilename(
      'attachment; filename="fallback.pdf"; filename*=UTF-8\'\'Offer%20Letter%3B%20Final.pdf',
      "fallback.pdf",
    ),
    "Offer Letter; Final.pdf",
  );
});

test("sanitizeCrmDocumentFilename strips path traversal", () => {
  assert.equal(sanitizeCrmDocumentFilename("../../bad.pdf", "fallback.pdf"), "bad.pdf");
  assert.equal(sanitizeCrmDocumentFilename("..\\..\\bad.pdf", "fallback.pdf"), "bad.pdf");
});

test("sanitizeCrmDocumentFilename replaces reserved characters", () => {
  assert.equal(sanitizeCrmDocumentFilename('bad<>:"|?*.pdf', "fallback.pdf"), "bad_______.pdf");
});

test("sanitizeCrmDocumentFilename falls back for empty or reserved names", () => {
  assert.equal(sanitizeCrmDocumentFilename("...", "fallback.pdf"), "fallback.pdf");
  assert.equal(sanitizeCrmDocumentFilename("CON", "fallback.pdf"), "fallback.pdf");
});

test("isCrmPdfResponse accepts application pdf content type", () => {
  assert.equal(
    isCrmPdfResponse({ "content-type": "application/pdf; charset=binary" }, Buffer.from("not magic")),
    true,
  );
});

test("isCrmPdfResponse accepts pdf magic bytes without content type", () => {
  assert.equal(isCrmPdfResponse({}, Buffer.from("%PDF-1.7\nbody")), true);
});

test("isCrmPdfResponse rejects HTTP 200 html bodies", () => {
  assert.equal(
    isCrmPdfResponse({ "content-type": "text/html" }, Buffer.from("<!doctype html><html>login</html>")),
    false,
  );
});

test("buildCrmDocumentFolderName title-cases ALL-CAPS CRM records and formats middle initial", () => {
  // CRM stores some records fully capitalised. The folder/zip name must look
  // the same either way — `Aadoceto, Aaf A. EID`, never `AADOCETO, AAF ...`.
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "AAF", lastName: "AADOCETO", middleName: "AIFAP" }),
    "Aadoceto, Aaf A. EID",
  );
  // ...and an already well-cased record is unchanged (idempotent).
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Jitir", lastName: "Cuweru", middleName: "Eurisifu" }),
    "Cuweru, Jitir E. EID",
  );
});

test("buildCrmDocumentFolderName title-cases across hyphens, apostrophes, and multi-word surnames", () => {
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "MARY-JANE", lastName: "O'BOWOM" }),
    "O'Bowom, Mary-Jane EID",
  );
  assert.equal(
    buildCrmDocumentFolderName({
      firstName: "VAR",
      lastName: "SIVIK NUTIKAC",
      livedName: "VAR SIVIK",
    }),
    "Sivik Nutikac, Var EID",
  );
});

test("known document positions get canonical names, not CRM's opaque id", () => {
  // CRM sends Content-Disposition names like "iDocs-2026-6-49682.pdf", which
  // identify nothing. Position 0 and 2 have known identities.
  assert.equal(CRM_DOC_DEFAULT_NAMES[0], "Signed Offer Letter");
  assert.equal(CRM_DOC_DEFAULT_NAMES[2], "EE Data Gathering Form");
  assert.equal(defaultCrmDocumentName(0), "Signed Offer Letter.pdf");
  assert.equal(defaultCrmDocumentName(2), "EE Data Gathering Form.pdf");
  // An unknown position still falls back to a positional name.
  assert.equal(defaultCrmDocumentName(4), "document-5.pdf");
});
