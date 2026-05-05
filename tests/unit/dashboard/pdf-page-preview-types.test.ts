import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseOathPrepareRowData,
  parsePrepareRowData,
} from "../../../src/dashboard/components/ocr/types.js";
import { getOcrDownstream } from "../../../src/dashboard/lib/ocr-downstream-registry.js";

test("parsePrepareRowData preserves pdfFileId for cached page previews", () => {
  const parsed = parsePrepareRowData({
    mode: "prepare",
    pdfPath: "/tmp/fake.pdf",
    pdfOriginalName: "fake.pdf",
    pdfFileId: "a".repeat(32),
    records: "[]",
  });
  assert.equal(parsed?.pdfFileId, "a".repeat(32));
});

test("parseOathPrepareRowData preserves pdfFileId for cached page previews", () => {
  const parsed = parseOathPrepareRowData({
    mode: "prepare",
    pdfPath: "/tmp/fake.pdf",
    pdfOriginalName: "fake.pdf",
    pdfFileId: "b".repeat(32),
    records: "[]",
  });
  assert.equal(parsed?.pdfFileId, "b".repeat(32));
});

test("OCR downstream registry parser exposes pdfFileId", () => {
  const parsed = getOcrDownstream("oath-signature").parseRow({
    mode: "prepare",
    pdfPath: "/tmp/fake.pdf",
    pdfOriginalName: "fake.pdf",
    pdfFileId: "c".repeat(32),
    records: "[]",
  });
  assert.equal(parsed?.pdfFileId, "c".repeat(32));
});
