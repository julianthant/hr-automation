import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { qrSvgFor } from "../../../src/capture/qr.js";

describe("qrSvgFor", () => {
  it("returns an SVG string", async () => {
    const svg = await qrSvgFor("http://192.168.1.50:3838/capture/abc123");
    assert.match(svg, /^<\?xml.*<svg|^<svg/s);
    assert.match(svg, /<\/svg>\s*$/);
  });

  it("encodes the URL into the SVG path", async () => {
    const svg = await qrSvgFor("http://example.com");
    assert.match(svg, /<path/);
  });
});
