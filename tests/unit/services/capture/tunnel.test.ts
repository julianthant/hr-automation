import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { extractQuickTunnelUrl } from "../../../../src/services/capture/tunnel.js";

describe("extractQuickTunnelUrl", () => {
  it("extracts the assigned quick-tunnel hostname from the banner", () => {
    const out = [
      "2026-07-01T17:50:07Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-07-01T17:50:09Z INF +--------------------------------------------+",
      "2026-07-01T17:50:09Z INF |  Your quick Tunnel has been created!        |",
      "2026-07-01T17:50:09Z INF |  https://districts-reaches-saved-slideshow.trycloudflare.com |",
      "2026-07-01T17:50:09Z INF +--------------------------------------------+",
    ].join("\n");
    assert.equal(
      extractQuickTunnelUrl(out),
      "https://districts-reaches-saved-slideshow.trycloudflare.com",
    );
  });

  it("does NOT return api.trycloudflare.com (the bug behind the 404)", () => {
    // cloudflared prints its own API host in log/error lines. The old script's
    // loose regex grabbed this and every phone request 404'd.
    const failLog =
      '2026-07-01T17:50:07Z INF Requesting new quick Tunnel on trycloudflare.com...\n' +
      'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": ' +
      "context deadline exceeded (Client.Timeout exceeded while awaiting headers)";
    assert.equal(extractQuickTunnelUrl(failLog), undefined);
  });

  it("skips api.* even when it appears before the real assigned URL", () => {
    const mixed =
      "connecting to https://api.trycloudflare.com/ ...\n" +
      "https://brave-lions-run-fast.trycloudflare.com";
    assert.equal(
      extractQuickTunnelUrl(mixed),
      "https://brave-lions-run-fast.trycloudflare.com",
    );
  });

  it("returns undefined when no trycloudflare URL is present yet", () => {
    assert.equal(extractQuickTunnelUrl("2026-07-01 INF Starting tunnel"), undefined);
    assert.equal(extractQuickTunnelUrl(""), undefined);
  });
});
