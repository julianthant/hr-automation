import { describe, it, beforeEach, afterEach } from "vitest";
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
  handleReplacePhoto,
  handleReorder,
  handleValidate,
} from "../../../../src/services/capture/server.js";
import {
  createSessionStore,
  type CapturedPhoto,
} from "../../../../src/services/capture/sessions.js";

const onFinalize = async (): Promise<void> => {};

function mkTmp(): string {
  const dir = join(os.tmpdir(), `capture-srv-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("handleManifest", () => {
  it("returns the session's manifest by token (photos as array)", () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    const r = handleManifest(s.token, { store });
    assert.equal(r.status, 200);
    const body = r.body as { state: string; photos: CapturedPhoto[]; workflow: string };
    assert.equal(body.state, "open");
    assert.equal(Array.isArray(body.photos), true);
    assert.equal(body.photos.length, 0);
    assert.equal(body.workflow, "x");
  });

  it("marks the session phone-connected on first hit", () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    handleManifest(s.token, {
      store,
      phoneInfo: { userAgent: "iPhone", ip: "10.0.0.5" },
    });
    assert.notEqual(store.getById(s.sessionId)!.phoneConnectedAt, undefined);
  });

  it("returns an expired manifest without reconnecting the phone", () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const s = store.create({ workflow: "x", onFinalize });
    now += 16 * 60_000;
    const r = handleManifest(s.token, {
      store,
      phoneInfo: { userAgent: "iPhone", ip: "10.0.0.5" },
    });
    assert.equal(r.status, 200);
    const body = r.body as { state: string };
    assert.equal(body.state, "expired");
    assert.equal(store.getById(s.sessionId)!.phoneConnectedAt, undefined);
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
    const body = r.body as { photoIndex: number; totalPhotos: number };
    assert.equal(body.photoIndex, 0);
    assert.equal(body.totalPhotos, 1);
    const sess = store.getById(s.sessionId)!;
    assert.equal(sess.photos.length, 1);
    assert.equal(sess.photos[0].mime, "image/jpeg");
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

  it("rejects upload after idle expiry (409)", async () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const s = store.create({ workflow: "x", onFinalize });
    now += 16 * 60_000;
    const r = await handleUpload(
      { token: s.token, bytes: Buffer.from([0]), originalName: "x.jpg" },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 409);
    assert.equal(store.getById(s.sessionId)!.state, "expired");
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

  it("removes the photo from the session and disk by stable id", async () => {
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
    // Photos have stable ids 0 and 1. Deleting id 0 leaves id 1.
    const r = await handleDeletePhoto(
      { token: s.token, index: 0 },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 200);
    const sess = store.getById(s.sessionId)!;
    assert.equal(sess.photos.length, 1);
    assert.equal(sess.photos[0].index, 1);
    const files = readdirSync(join(tmp, s.sessionId));
    assert.equal(files.length, 1);
  });

  it("returns 404 for unknown token", async () => {
    const store = createSessionStore();
    const r = await handleDeletePhoto({ token: "nope", index: 0 }, { store, photosDir: tmp });
    assert.equal(r.status, 404);
  });

  it("returns 400 for unknown stable id", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    const r = await handleDeletePhoto(
      { token: s.token, index: 99 },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 400);
  });

  it("returns 409 when deleting after idle expiry", async () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const s = store.create({ workflow: "x", onFinalize });
    await handleUpload(
      { token: s.token, bytes: Buffer.from([1]), originalName: "a.jpg" },
      { store, photosDir: tmp },
    );
    now += 16 * 60_000;
    const r = await handleDeletePhoto({ token: s.token, index: 0 }, { store, photosDir: tmp });
    assert.equal(r.status, 409);
  });

  it("does not reuse a surviving photo filename after delete", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    await handleUpload(
      { token: s.token, bytes: Buffer.from([1]), originalName: "a.jpg" },
      { store, photosDir: tmp },
    );
    await handleUpload(
      { token: s.token, bytes: Buffer.from([2]), originalName: "b.jpg" },
      { store, photosDir: tmp },
    );
    await handleUpload(
      { token: s.token, bytes: Buffer.from([3]), originalName: "c.jpg" },
      { store, photosDir: tmp },
    );
    await handleDeletePhoto({ token: s.token, index: 1 }, { store, photosDir: tmp });
    await handleUpload(
      { token: s.token, bytes: Buffer.from([4]), originalName: "d.jpg" },
      { store, photosDir: tmp },
    );
    const filenames = store.getById(s.sessionId)!.photos.map((p) => p.filename);
    assert.equal(new Set(filenames).size, filenames.length);
  });
});

describe("handleReplacePhoto", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("replaces an uploaded photo and preserves the stable id", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    await handleUpload(
      { token: s.token, bytes: Buffer.from([0xff, 0xd8, 0xff]), originalName: "a.jpg" },
      { store, photosDir: tmp },
    );
    const r = await handleReplacePhoto(
      {
        token: s.token,
        index: 0,
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        originalName: "a-retake.png",
      },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 200);
    const sess = store.getById(s.sessionId)!;
    assert.equal(sess.photos.length, 1);
    assert.equal(sess.photos[0].index, 0); // stable id preserved
    assert.equal(sess.photos[0].mime, "image/png");
    // Both old + new file remain on disk for forensics.
    const files = readdirSync(join(tmp, s.sessionId));
    assert.equal(files.length, 2);
  });

  it("returns 400 for unknown stable id", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    const r = await handleReplacePhoto(
      {
        token: s.token,
        index: 99,
        bytes: Buffer.from([0xff, 0xd8, 0xff]),
        originalName: "x.jpg",
      },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 400);
  });

  it("rejects replacement of finalized session", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    await handleUpload(
      { token: s.token, bytes: Buffer.from([0xff, 0xd8, 0xff]), originalName: "a.jpg" },
      { store, photosDir: tmp },
    );
    store.setState(s.sessionId, "finalized");
    const r = await handleReplacePhoto(
      {
        token: s.token,
        index: 0,
        bytes: Buffer.from([0xff, 0xd8, 0xff]),
        originalName: "x.jpg",
      },
      { store, photosDir: tmp },
    );
    assert.equal(r.status, 409);
  });
});

describe("handleReorder", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reorders by array position", async () => {
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
    await handleUpload(
      { token: s.token, bytes: Buffer.from([0xff, 0xd8, 0xff]), originalName: "c.jpg" },
      { store, photosDir: tmp },
    );
    const r = handleReorder(
      { token: s.token, fromIndex: 0, toIndex: 2 },
      { store },
    );
    assert.equal(r.status, 200);
    const sess = store.getById(s.sessionId)!;
    // Photos travel with their stable ids — moving position 0 to position 2
    // means stable id 0 (the first uploaded photo) is now at the tail.
    assert.deepEqual(
      sess.photos.map((p) => p.index),
      [1, 2, 0],
    );
  });

  it("returns 400 for invalid positions", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    await handleUpload(
      { token: s.token, bytes: Buffer.from([0xff, 0xd8, 0xff]), originalName: "a.jpg" },
      { store, photosDir: tmp },
    );
    const r = handleReorder(
      { token: s.token, fromIndex: 0, toIndex: 9 },
      { store },
    );
    assert.equal(r.status, 400);
  });

  it("rejects reorder of finalized session", async () => {
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
    store.setState(s.sessionId, "finalized");
    const r = handleReorder(
      { token: s.token, fromIndex: 0, toIndex: 1 },
      { store },
    );
    assert.equal(r.status, 409);
  });
});

describe("handleValidate", () => {
  it("blocks empty sessions", () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    const r = handleValidate({ sessionId: s.sessionId }, { store });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; blockers?: string[] };
    assert.equal(body.ok, false);
    assert.ok(body.blockers && body.blockers.length > 0);
  });

  it("returns ok=true for a session with at least one photo", async () => {
    const store = createSessionStore();
    const s = store.create({ workflow: "x", onFinalize });
    const tmp = mkTmp();
    try {
      await handleUpload(
        { token: s.token, bytes: Buffer.from([0xff, 0xd8, 0xff]), originalName: "a.jpg" },
        { store, photosDir: tmp },
      );
      const r = handleValidate({ sessionId: s.sessionId }, { store });
      const body = r.body as { ok: boolean };
      assert.equal(body.ok, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns 404 for unknown sessionId", () => {
    const store = createSessionStore();
    const r = handleValidate({ sessionId: "no-such-id" }, { store });
    assert.equal(r.status, 404);
  });
});
