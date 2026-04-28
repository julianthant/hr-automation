import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseBoundary,
  parseMultipartBuffer,
} from "../../../src/tracker/multipart-helper.js";

const BOUNDARY = "----boundary123";

function makeMultipart(parts: Array<{ headers: string[]; body: Buffer | string }>): Buffer {
  const segments: Buffer[] = [];
  for (const p of parts) {
    segments.push(Buffer.from(`--${BOUNDARY}\r\n`));
    segments.push(Buffer.from(p.headers.join("\r\n") + "\r\n\r\n"));
    segments.push(typeof p.body === "string" ? Buffer.from(p.body) : p.body);
    segments.push(Buffer.from("\r\n"));
  }
  segments.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(segments);
}

describe("parseBoundary", () => {
  it("extracts an unquoted boundary token", () => {
    assert.equal(
      parseBoundary("multipart/form-data; boundary=----xyz"),
      "----xyz",
    );
  });

  it("extracts a quoted boundary token", () => {
    assert.equal(
      parseBoundary('multipart/form-data; boundary="----xyz"'),
      "----xyz",
    );
  });

  it("returns undefined for non-multipart content types", () => {
    assert.equal(parseBoundary("application/json"), undefined);
    assert.equal(parseBoundary(undefined), undefined);
  });

  it("returns undefined when the boundary parameter is missing", () => {
    assert.equal(parseBoundary("multipart/form-data"), undefined);
  });
});

describe("parseMultipartBuffer", () => {
  it("parses a single text field", () => {
    const buf = makeMultipart([
      {
        headers: [`Content-Disposition: form-data; name="rosterMode"`],
        body: "existing",
      },
    ]);
    const result = parseMultipartBuffer(buf, BOUNDARY);
    assert.equal(result.fields.rosterMode, "existing");
    assert.equal(result.parts.length, 1);
    assert.equal(result.parts[0].kind, "text");
  });

  it("parses a single file part with binary content", () => {
    const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"
    const buf = makeMultipart([
      {
        headers: [
          `Content-Disposition: form-data; name="pdf"; filename="scan.pdf"`,
          `Content-Type: application/pdf`,
        ],
        body: pdfBytes,
      },
    ]);
    const result = parseMultipartBuffer(buf, BOUNDARY);
    const file = result.files["pdf"];
    assert.ok(file, "pdf file part should exist");
    assert.equal(file.filename, "scan.pdf");
    assert.equal(file.contentType, "application/pdf");
    assert.deepEqual([...file.data], [...pdfBytes]);
  });

  it("parses mixed file + field parts", () => {
    const pdfBytes = Buffer.from([0x01, 0x02, 0x03]);
    const buf = makeMultipart([
      {
        headers: [`Content-Disposition: form-data; name="rosterMode"`],
        body: "download",
      },
      {
        headers: [
          `Content-Disposition: form-data; name="pdf"; filename="x.pdf"`,
          `Content-Type: application/pdf`,
        ],
        body: pdfBytes,
      },
    ]);
    const result = parseMultipartBuffer(buf, BOUNDARY);
    assert.equal(result.fields.rosterMode, "download");
    assert.deepEqual([...result.files.pdf.data], [...pdfBytes]);
    assert.equal(result.parts.length, 2);
  });

  it("returns empty when boundary doesn't match", () => {
    const buf = makeMultipart([
      {
        headers: [`Content-Disposition: form-data; name="x"`],
        body: "1",
      },
    ]);
    const result = parseMultipartBuffer(buf, "wrong-boundary");
    assert.equal(result.parts.length, 0);
  });

  it("handles a part without a filename as a text field", () => {
    const buf = makeMultipart([
      {
        headers: [`Content-Disposition: form-data; name="note"`],
        body: "hello",
      },
    ]);
    const result = parseMultipartBuffer(buf, BOUNDARY);
    assert.equal(result.fields.note, "hello");
    assert.equal(result.files.note, undefined);
  });
});
