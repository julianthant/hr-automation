import { test } from "vitest";
import assert from "node:assert/strict";

import {
  parseOathPrepareRowData,
  parsePrepareRowData,
} from "../../../src/dashboard/components/ocr/types.js";
import {
  isPreviewNearViewport,
  resolveDashboardApiSrc,
} from "../../../src/dashboard/components/shared/PdfPagePreview.js";
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

test("isPreviewNearViewport treats pages inside the preload margin as loadable", () => {
  assert.equal(
    isPreviewNearViewport(
      { top: 950, bottom: 1250, left: 0, right: 400 },
      { width: 1200, height: 800 },
      200,
    ),
    true,
  );
  assert.equal(
    isPreviewNearViewport(
      { top: 1201, bottom: 1500, left: 0, right: 400 },
      { width: 1200, height: 800 },
      200,
    ),
    false,
  );
});

test("resolveDashboardApiSrc bypasses the Vite proxy for local dashboard previews", () => {
  assert.equal(
    resolveDashboardApiSrc("/api/files/file-1/pages/1", { protocol: "http:", hostname: "localhost", port: "5173" }),
    "http://localhost:3838/api/files/file-1/pages/1",
  );
  assert.equal(
    resolveDashboardApiSrc("/api/files/file-1/pages/1", { protocol: "http:", hostname: "localhost", port: "3838" }),
    "/api/files/file-1/pages/1",
  );
});
