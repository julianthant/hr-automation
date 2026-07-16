import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";

/**
 * Pins that Run-modal PDF uploads (XHR) can obtain the same operator session
 * the `fetch` wrapper uses. After the 2026-07-15 capture-port split, uploads
 * post same-origin to `/api/ocr/prepare` and must carry the operator header —
 * XHR bypasses `installOperatorFetchAuth`, so `getOperatorSession` is the
 * shared seam.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("getOperatorSession returns session from /api/operator/session", async () => {
  const fetchMock = vi.fn((..._args: Parameters<typeof fetch>) =>
    Promise.resolve(new Response(
      JSON.stringify({ token: "sess-abc", header: "x-hr-auto-operator-token" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )),
  );
  vi.stubGlobal("fetch", fetchMock);

  const { getOperatorSession } = await import("../../../src/dashboard/lib/operator-auth.js");
  const session = await getOperatorSession();
  assert.equal(session.token, "sess-abc");
  assert.equal(session.header, "x-hr-auto-operator-token");
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(fetchMock.mock.calls[0]?.[0], "/api/operator/session");

  // Second call is cached — no extra fetch.
  const again = await getOperatorSession();
  assert.equal(again.token, "sess-abc");
  assert.equal(fetchMock.mock.calls.length, 1);
});

test("getOperatorSession fails loud when the session endpoint is unavailable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("nope", { status: 503 }))),
  );

  const { getOperatorSession } = await import("../../../src/dashboard/lib/operator-auth.js");
  await assert.rejects(
    () => getOperatorSession(),
    /Operator session unavailable \(503\)/,
  );
});
