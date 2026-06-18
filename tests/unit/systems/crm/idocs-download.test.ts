import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  buildCrmDocumentDownloadPath,
  buildCrmDocumentFolderName,
  sanitizeOnboardingFolderName,
  parseCrmDocumentFilename,
  sanitizeCrmDocumentFilename,
  isCrmPdfResponse,
  DEFAULT_CRM_DOC_INDICES,
} from "../../../../src/systems/crm/idocs-download.js";

const ONBOARDING_DIR = join(homedir(), "Documents", "onboarding");

test("DEFAULT_CRM_DOC_INDICES downloads Doc 1 and Doc 3", () => {
  assert.deepEqual(DEFAULT_CRM_DOC_INDICES, [0, 2]);
});

test("buildCrmDocumentDownloadPath lands under ~/Documents/onboarding", () => {
  assert.equal(
    buildCrmDocumentDownloadPath({ firstName: "Jane", lastName: "Doe", middleName: "A" }),
    join(ONBOARDING_DIR, "Doe, Jane A EID"),
  );
});

test("buildCrmDocumentFolderName: Last, First Middle EID (no lived name)", () => {
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Jane", lastName: "Doe", middleName: "A" }),
    "Doe, Jane A EID",
  );
});

test("buildCrmDocumentFolderName inserts the lived name parenthetically", () => {
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "John", lastName: "Smith", middleName: "Michael", livedName: "Johnny" }),
    "Smith, John (Johnny) Michael EID",
  );
});

test("buildCrmDocumentFolderName omits absent/blank middle and lived name", () => {
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Ada", lastName: "Lovelace", middleName: "", livedName: "  " }),
    "Lovelace, Ada EID",
  );
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Ada", lastName: "Lovelace" }),
    "Lovelace, Ada EID",
  );
});

test("buildCrmDocumentFolderName lived name without middle", () => {
  assert.equal(
    buildCrmDocumentFolderName({ firstName: "Robert", lastName: "Roe", livedName: "Bob" }),
    "Roe, Robert (Bob) EID",
  );
});

test("sanitizeOnboardingFolderName drops path separators, keeps name punctuation", () => {
  // Apostrophes / commas / parens survive; a stray slash does not become a subdir.
  assert.equal(sanitizeOnboardingFolderName("O'Brien, Sean (Seanie) EID"), "O'Brien, Sean (Seanie) EID");
  assert.equal(sanitizeOnboardingFolderName("De/Vries, Anne EID"), "DeVries, Anne EID");
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
