import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isPublicCaptureRequestAllowed } from "../../../../src/tracker/dashboard/hono/public-scope.js";

describe("isPublicCaptureRequestAllowed", () => {
  it("allows exactly the phone-side capture endpoints", () => {
    assert.equal(isPublicCaptureRequestAllowed("GET", "/capture/aBc123Token"), true);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/capture-assets/heic2any.min.js"), true);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/api/capture/manifest/aBc123Token"), true);
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/capture/upload"), true);
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/capture/replace-photo"), true);
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/capture/delete-photo"), true);
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/capture/reorder"), true);
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/capture/finalize"), true);
  });

  it("BLOCKS the dashboard SPA and non-capture APIs (PII + controls)", () => {
    assert.equal(isPublicCaptureRequestAllowed("GET", "/"), false);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/index.html"), false);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/api/entries"), false);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/api/runs"), false);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/api/failures"), false);
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/enqueue"), false);
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/retry"), false);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/api/settings"), false);
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/settings"), false);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/events/hub"), false);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/assets/index-abc.js"), false);
  });

  it("BLOCKS operator-only capture endpoints (start/discard/validate/sessions/photos/registry)", () => {
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/capture/start"), false);
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/capture/discard"), false);
    assert.equal(isPublicCaptureRequestAllowed("POST", "/api/capture/validate"), false);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/api/capture/sessions"), false);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/api/capture/photos/some-session-id/0"), false);
    assert.equal(isPublicCaptureRequestAllowed("GET", "/api/capture/registry"), false);
  });

  it("does not confuse method (a capture path with the wrong verb is blocked)", () => {
    assert.equal(isPublicCaptureRequestAllowed("GET", "/api/capture/upload"), false);
    assert.equal(isPublicCaptureRequestAllowed("DELETE", "/api/capture/finalize"), false);
  });

  it("allows OPTIONS preflight through (answered by the CORS handler)", () => {
    assert.equal(isPublicCaptureRequestAllowed("OPTIONS", "/api/entries"), true);
  });
});
