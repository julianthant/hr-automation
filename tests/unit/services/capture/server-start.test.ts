import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { handleStart } from "../../../../src/services/capture/server.js";
import { createSessionStore } from "../../../../src/services/capture/sessions.js";

const onFinalize = async (): Promise<void> => {};

describe("handleStart", () => {
  it("creates a session and returns sessionId + captureUrl + qrSvg", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "oath-signature", contextHint: "Roster 1" },
      {
        store,
        publicUrl: "https://capture.example.test",
        onFinalize,
      },
    );
    assert.equal(r.status, 200);
    const body = r.body as {
      sessionId: string;
      token: string;
      captureUrl: string;
      qrSvg: string;
    };
    assert.equal(typeof body.sessionId, "string");
    assert.match(body.captureUrl, /^https:\/\/capture\.example\.test\/capture\//);
    assert.match(body.qrSvg, /<svg/);
    const session = store.getById(body.sessionId)!;
    assert.equal(body.captureUrl.endsWith(session.token), true);
  });

  it("returns 400 when workflow is missing", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "" },
      { store, publicUrl: "https://capture.example.test", onFinalize },
    );
    assert.equal(r.status, 400);
  });

  it("returns 503 when no publicUrl is available", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "x" },
      { store, onFinalize },
    );
    assert.equal(r.status, 503);
    const body = r.body as { error?: string };
    assert.match(body.error ?? "", /requires ngrok or CAPTURE_PUBLIC_URL/);
    assert.match(body.error ?? "", /no LAN fallback/);
  });

  it("uses publicUrl as the capture origin", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "oath-signature" },
      {
        store,
        publicUrl: "https://capture.example.test",
        onFinalize,
      },
    );
    assert.equal(r.status, 200);
    const body = r.body as { captureUrl: string };
    assert.match(body.captureUrl, /^https:\/\/capture\.example\.test\/capture\//);
  });

  it("trims a trailing slash from publicUrl", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "oath-signature" },
      {
        store,
        publicUrl: "https://capture.example.test/",
        onFinalize,
      },
    );
    assert.equal(r.status, 200);
    const body = r.body as { captureUrl: string };
    assert.match(body.captureUrl, /^https:\/\/capture\.example\.test\/capture\//);
  });

  it("uses publicUrl as the only capture origin", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "oath-signature" },
      {
        store,
        publicUrl: "https://capture.example.test",
        onFinalize,
      },
    );
    assert.equal(r.status, 200);
    const body = r.body as { captureUrl: string };
    assert.match(body.captureUrl, /^https:\/\/capture\.example\.test\/capture\//);
  });
});
