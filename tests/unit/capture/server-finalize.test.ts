import { describe, it, beforeEach, afterEach } from "node:test";
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
} from "../../../src/capture/server.js";
import { createSessionStore } from "../../../src/capture/sessions.js";

function mkTmp(): string {
  const dir = join(os.tmpdir(), `capture-fin-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Wait for a condition with polling — used to await background bundle work.
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("handleFinalize", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 200 immediately and bundles a (zero-photo) PDF in background", async () => {
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
    assert.equal(r.status, 200);

    // Wait for background bundle + onFinalize.
    await waitFor(() => store.getById(s.sessionId)?.state === "finalized");
    assert.equal(onFinalizeCalls, 1);
    const sess = store.getById(s.sessionId)!;
    assert.equal(sess.state, "finalized");
    assert.equal(typeof sess.pdfPath, "string");
    assert.equal(existsSync(sess.pdfPath!), true);
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
