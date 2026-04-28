import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  handleManifest,
  handleUpload,
  handleDeletePhoto,
} from "../../../src/capture/server.js";
import { createSessionStore } from "../../../src/capture/sessions.js";

const onFinalize = async (): Promise<void> => {};

function mkTmp(): string {
  const dir = join(os.tmpdir(), `capture-srv-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("handleManifest", () => {
  it("returns the session's manifest by token", () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    const r = handleManifest(s.token, { store });
    assert.equal(r.status, 200);
    const body = r.body as { state: string; photos: number };
    assert.equal(body.state, "open");
    assert.equal(body.photos, 0);
  });

  it("returns 404 for unknown token", () => {
    const store = createSessionStore();
    const r = handleManifest("nope", { store });
    assert.equal(r.status, 404);
  });
});

describe("handleUpload", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the photo to disk and adds to the session", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    const bytes = Buffer.from([0xff, 0xd8, 0xff]);
    const r = await handleUpload(
      { token: s.token, bytes, originalName: "IMG_001.jpg" },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 200);
    const sess = store.getById(s.sessionId)!;
    assert.equal(sess.photos.length, 1);
    const dir = join(tmp, s.sessionId);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(dir, files[0])).length, 3);
  });

  it("returns 404 for unknown token", async () => {
    const store = createSessionStore();
    const r = await handleUpload(
      { token: "nope", bytes: Buffer.from([0]), originalName: "x.jpg" },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 404);
  });

  it("rejects upload to a finalized session (409)", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    store.setState(s.sessionId, "finalized");
    const r = await handleUpload(
      { token: s.token, bytes: Buffer.from([0]), originalName: "x.jpg" },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 409);
  });

  it("rejects empty bytes (400)", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    const r = await handleUpload(
      { token: s.token, bytes: Buffer.from([]), originalName: "x.jpg" },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 400);
  });

  it("rejects too-large uploads (413)", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    const big = Buffer.alloc(11 * 1024 * 1024);
    const r = await handleUpload(
      { token: s.token, bytes: big, originalName: "x.jpg" },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 413);
  });
});

describe("handleDeletePhoto", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the photo from the session and disk", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    await handleUpload(
      { token: s.token, bytes: Buffer.from([0xff, 0xd8, 0xff]), originalName: "a.jpg" },
      { store, photosDir: tmp },
    );
    await handleUpload(
      { token: s.token, bytes: Buffer.from([0xff, 0xd8, 0xff]), originalName: "b.jpg" },
      { store, photosDir: tmp },
    );
    const r = handleDeletePhoto(
      { token: s.token, index: 0 },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 200);
    const sess = store.getById(s.sessionId)!;
    assert.equal(sess.photos.length, 1);
    const files = readdirSync(join(tmp, s.sessionId));
    assert.equal(files.length, 1);
  });

  it("returns 404 for unknown token", () => {
    const store = createSessionStore();
    const r = handleDeletePhoto({ token: "nope", index: 0 }, { store, photosDir: tmp });
    assert.equal(r.status, 404);
  });

  it("returns 400 for out-of-range index", () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    const r = handleDeletePhoto(
      { token: s.token, index: 99 },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 400);
  });
});
