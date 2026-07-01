import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  isExternalCaptureRequest,
  isPublicCaptureRequestAllowed,
} from "../../../../src/tracker/dashboard/hono/public-scope.js";

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

describe("isExternalCaptureRequest", () => {
  const publicUrl = "https://districts-reaches-saved-slideshow.trycloudflare.com";

  it("is never external when no public origin is configured", () => {
    assert.equal(
      isExternalCaptureRequest({
        hostHeader: "districts-reaches-saved-slideshow.trycloudflare.com",
        publicUrl: undefined,
        cfConnectingIp: "203.0.113.7",
      }),
      false,
    );
  });

  it("is external when the Cloudflare edge header is present", () => {
    assert.equal(
      isExternalCaptureRequest({ hostHeader: "anything", publicUrl, cfConnectingIp: "203.0.113.7" }),
      true,
    );
  });

  it("is external when the Host matches the public origin's host", () => {
    assert.equal(
      isExternalCaptureRequest({
        hostHeader: "districts-reaches-saved-slideshow.trycloudflare.com",
        publicUrl,
        cfConnectingIp: null,
      }),
      true,
    );
  });

  it("is NOT external for local operator access (localhost / LAN, no cf header)", () => {
    for (const host of ["localhost:3838", "127.0.0.1:3838", "[::1]:3838", "100.64.71.114:3838"]) {
      assert.equal(
        isExternalCaptureRequest({ hostHeader: host, publicUrl, cfConnectingIp: null }),
        false,
        `expected ${host} to be local`,
      );
    }
  });

  it("returns false on an unparseable publicUrl (fail closed to local-only, no crash)", () => {
    assert.equal(
      isExternalCaptureRequest({ hostHeader: "whatever", publicUrl: "not a url", cfConnectingIp: null }),
      false,
    );
  });
});
