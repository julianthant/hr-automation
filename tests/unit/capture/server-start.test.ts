import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleStart } from "../../../src/capture/server.js";
import { createSessionStore } from "../../../src/capture/sessions.js";

const onFinalize = async (): Promise<void> => {};

describe("handleStart", () => {
  it("creates a session and returns sessionId + captureUrl + qrSvg", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "oath-signature", contextHint: "Roster 1" },
      { store, lanIp: "192.168.1.50", port: 3838, onFinalize },
    );
    assert.equal(r.status, 200);
    const body = r.body as {
      sessionId: string;
      token: string;
      captureUrl: string;
      qrSvg: string;
    };
    assert.equal(typeof body.sessionId, "string");
    assert.match(body.captureUrl, /^http:\/\/192\.168\.1\.50:3838\/capture\//);
    assert.match(body.qrSvg, /<svg/);
    const session = store.getById(body.sessionId)!;
    assert.equal(body.captureUrl.endsWith(session.token), true);
  });

  it("returns 400 when workflow is missing", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "" },
      { store, lanIp: "192.168.1.50", port: 3838, onFinalize },
    );
    assert.equal(r.status, 400);
  });

  it("returns 503 when no LAN IP is available", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "x" },
      { store, lanIp: undefined, port: 3838, onFinalize },
    );
    assert.equal(r.status, 503);
  });

  it("uses publicUrl override and ignores lanIp:port when both present", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "oath-signature" },
      {
        store,
        lanIp: "192.168.1.50",
        port: 3838,
        publicUrl: "https://abc.trycloudflare.com",
        onFinalize,
      },
    );
    assert.equal(r.status, 200);
    const body = r.body as { captureUrl: string };
    assert.match(body.captureUrl, /^https:\/\/abc\.trycloudflare\.com\/capture\//);
    assert.ok(!body.captureUrl.includes("192.168.1.50"));
    assert.ok(!body.captureUrl.includes(":3838"));
  });

  it("publicUrl alone is enough — no lanIp needed", async () => {
    const store = createSessionStore();
    const r = await handleStart(
      { workflow: "oath-signature" },
      {
        store,
        lanIp: undefined,
        port: 3838,
        publicUrl: "https://abc.trycloudflare.com/",
        onFinalize,
      },
    );
    assert.equal(r.status, 200);
    const body = r.body as { captureUrl: string };
    assert.match(body.captureUrl, /^https:\/\/abc\.trycloudflare\.com\/capture\//);
  });
});
