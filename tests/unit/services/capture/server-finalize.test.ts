import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  handleFinalize,
  handleDiscard,
  handleUpload,
} from "../../../../src/services/capture/server.js";
import { createSessionStore } from "../../../../src/services/capture/sessions.js";

function mkTmp(): string {
  const dir = join(os.tmpdir(), `capture-fin-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("handleFinalize", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects a zero-photo finalize (400) instead of bundling a blank PDF", async () => {
    let onFinalizeCalls = 0;
    const onFinalize = async (): Promise<void> => {
      onFinalizeCalls += 1;
    };
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });

    const r = await handleFinalize(
      { token: s.token },
      { store, photosDir: tmp, uploadsDir: join(tmp, "uploads") },
    );
    assert.equal(r.status, 400);
    const body = r.body as { ok: boolean; error?: string };
    assert.match(body.error ?? "", /no photos captured/i);

    // Session stays open — never enters finalizing/finalized, and onFinalize
    // (and the downstream OCR/operation pipeline) never fires.
    assert.equal(store.getById(s.sessionId)!.state, "open");
    assert.equal(onFinalizeCalls, 0);
  });

  it("returns 404 for unknown token", async () => {
    const store = createSessionStore();
    const r = await handleFinalize(
      { token: "nope" },
      { store, photosDir: tmp, uploadsDir: tmp },
    );
    assert.equal(r.status, 404);
  });

  it("rejects double-finalize (409)", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize: async () => {} });
    store.setState(s.sessionId, "finalized");
    const r = await handleFinalize(
      { token: s.token },
      { store, photosDir: tmp, uploadsDir: tmp },
    );
    assert.equal(r.status, 409);
  });

  it("rejects finalize after idle expiry (409)", async () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const s = store.create({ workflow: "x", onFinalize: async () => {} });
    now += 16 * 60_000;
    const r = await handleFinalize(
      { token: s.token },
      { store, photosDir: tmp, uploadsDir: tmp },
    );
    assert.equal(r.status, 409);
    assert.equal(store.getById(s.sessionId)!.state, "expired");
  });
});

describe("handleDiscard", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("marks the session discarded", () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize: async () => {} });
    const r = handleDiscard({ sessionId: s.sessionId }, { store, photosDir: tmp });
    assert.equal(r.status, 200);
    assert.equal(store.getById(s.sessionId)!.state, "discarded");
  });

  it("returns 404 for unknown sessionId", () => {
    const store = createSessionStore();
    const r = handleDiscard({ sessionId: "nope" }, { store, photosDir: tmp });
    assert.equal(r.status, 404);
  });

  it("removes the session photos directory (best-effort)", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize: async () => {} });
    await handleUpload(
      { token: s.token, bytes: Buffer.from([0xff, 0xd8, 0xff]), originalName: "a.jpg" },
      { store, photosDir: tmp },
    );
    const photoDir = join(tmp, s.sessionId);
    assert.equal(existsSync(photoDir), true);
    handleDiscard({ sessionId: s.sessionId }, { store, photosDir: tmp });
    assert.equal(existsSync(photoDir), false);
  });
});
