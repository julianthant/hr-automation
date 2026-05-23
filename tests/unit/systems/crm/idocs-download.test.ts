import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  buildCrmDocumentDownloadPath,
  parseCrmDocumentFilename,
  sanitizeCrmDocumentFilename,
  isCrmPdfResponse,
  DEFAULT_CRM_DOC_INDICES,
} from "../../../../src/systems/crm/idocs-download.js";

test("DEFAULT_CRM_DOC_INDICES downloads Doc 1 and Doc 3", () => {
  assert.deepEqual(DEFAULT_CRM_DOC_INDICES, [0, 2]);
});

test("buildCrmDocumentDownloadPath matches onboarding folder convention", () => {
  assert.equal(
    buildCrmDocumentDownloadPath({ firstName: "Jane", lastName: "Doe", middleName: "A" }),
    join(homedir(), "Downloads", "onboarding", "Doe, Jane A EID"),
  );
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
