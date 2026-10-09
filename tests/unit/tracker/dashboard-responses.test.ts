import { test } from "vitest";
import assert from "node:assert/strict";

import {
  jsonResponse,
  preflightResponse,
  readJsonRequest,
} from "../../../src/tracker/dashboard/hono/responses.js";
import { sseResponse } from "../../../src/tracker/dashboard/hono/sse.js";

test("readJsonRequest parses empty body as an empty object", async () => {
  const parsed = await readJsonRequest(new Request("http://localhost", { method: "POST" }));
  assert.deepEqual(parsed, { ok: true, body: {} });
});

test("readJsonRequest returns Invalid JSON body for malformed JSON", async () => {
  const parsed = await readJsonRequest(new Request("http://localhost", { method: "POST", body: "{bad" }));
  assert.deepEqual(parsed, { ok: false, error: "Invalid JSON body" });
});

test("readJsonRequest rejects non-object JSON bodies", async () => {
  for (const body of ["[]", "null", "\"hi\"", "42"]) {
    const parsed = await readJsonRequest(new Request("http://localhost", { method: "POST", body }));
    assert.deepEqual(parsed, { ok: false, error: "Request body must be a JSON object" });
  }
});

test("readJsonRequest enforces maxBytes", async () => {
  const parsed = await readJsonRequest(
    new Request("http://localhost", { method: "POST", body: JSON.stringify({ value: "abcdef" }) }),
    8,
  );
  assert.deepEqual(parsed, { ok: false, error: "Request body too large" });
});

test("jsonResponse leaves CORS to the request boundary", async () => {
  const response = jsonResponse({ ok: true }, 202);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(await response.text(), "{\"ok\":true}");
});

test("test-only preflight response does not grant wildcard origin access", () => {
  const response = preflightResponse();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("sseResponse preserves event-stream headers and sends JSON data blocks", async () => {
  const response = sseResponse((send) => {
    send({ ok: true });
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("Cache-Control"), "no-cache");
  assert.equal(response.headers.get("Connection"), "keep-alive");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);

  const reader = response.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  assert.equal(new TextDecoder().decode(value), "data: {\"ok\":true}\n\n");
});

test("sseResponse disconnects a slow client instead of buffering without bound", async () => {
  let cleanupRan = false;
  let sendRef: ((data: unknown) => void) | undefined;
  const response = sseResponse((send) => {
    sendRef = send;
    return () => {
      cleanupRan = true;
    };
  });
  assert.ok(sendRef);
  // Let the async start() finish registering the cleanup before flooding.
  await Promise.resolve();

  // Never read from the stream — every send buffers. The writer must kick the
  // consumer once the buffered-message bound is crossed, running cleanup so the
  // topic intervals stop, rather than growing the buffer forever.
  for (let i = 0; i < 600 && !cleanupRan; i++) {
    sendRef!({ tick: i, payload: "x".repeat(64) });
  }
  assert.ok(cleanupRan, "cleanup must run once the slow client crosses the buffer bound");

  // Post-kick sends are no-ops (no throw, no further buffering).
  sendRef!({ afterKick: true });
  await response.body!.cancel();
});
