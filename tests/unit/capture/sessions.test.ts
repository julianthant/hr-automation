import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionStore,
  type CaptureSession,
  type CaptureSessionEvent,
} from "../../../src/capture/sessions.js";

const onFinalize = async (): Promise<void> => {};

const photoInput = (filename: string, sizeBytes = 100): {
  filename: string;
  sizeBytes: number;
  mime: string;
} => ({ filename, sizeBytes, mime: "image/jpeg" });

describe("CaptureSessionStore", () => {
  it("create returns a session with sessionId, token, and timestamps", () => {
    const store = createSessionStore({ now: () => 1_000_000 });
    const s = store.create({ workflow: "oath-signature", onFinalize });
    assert.equal(s.workflow, "oath-signature");
    assert.equal(s.state, "open");
    assert.equal(typeof s.sessionId, "string");
    assert.equal(typeof s.token, "string");
    assert.equal(s.token.length >= 16, true);
    assert.equal(s.sessionId.length >= 16, true);
    assert.equal(s.createdAt, 1_000_000);
    assert.equal(s.expiresAt, 1_000_000 + 15 * 60 * 1000);
    assert.equal(s.photos.length, 0);
    assert.equal(s.phoneConnectedAt, undefined);
  });

  it("sessionId and token are distinct", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    assert.notEqual(s.sessionId, s.token);
  });

  it("getById returns the session", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    assert.deepEqual(store.getById(s.sessionId), s);
  });

  it("getByToken returns the session", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    assert.deepEqual(store.getByToken(s.token), s);
  });

  it("getByToken returns undefined for unknown token", () => {
    const store = createSessionStore({ now: () => 0 });
    assert.equal(store.getByToken("nope"), undefined);
  });

  it("addPhoto assigns a stable monotonic index and bumps expiresAt", () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const s = store.create({ workflow: "x", onFinalize });
    now += 60_000;
    const a = store.addPhoto(s.sessionId, photoInput("a.jpg", 100));
    assert.ok(a);
    assert.equal(a.index, 0);
    assert.equal(a.filename, "a.jpg");
    assert.equal(a.sizeBytes, 100);
    assert.equal(a.mime, "image/jpeg");
    assert.equal(a.uploadedAt, now);
    assert.equal(store.getById(s.sessionId)!.expiresAt, now + 15 * 60_000);

    now += 30_000;
    const b = store.addPhoto(s.sessionId, photoInput("b.jpg", 200));
    assert.equal(b!.index, 1);
  });

  it("setState transitions and is irreversible from terminal", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    store.setState(s.sessionId, "finalizing");
    assert.equal(store.getById(s.sessionId)!.state, "finalizing");
    store.setState(s.sessionId, "finalized");
    assert.equal(store.getById(s.sessionId)!.state, "finalized");
    store.setState(s.sessionId, "open");
    assert.equal(store.getById(s.sessionId)!.state, "finalized");
  });

  it("sweepExpired marks sessions past expiresAt as 'expired'", () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const s = store.create({ workflow: "x", onFinalize });
    now += 16 * 60_000;
    const swept = store.sweepExpired();
    assert.equal(swept, 1);
    assert.equal(store.getById(s.sessionId)!.state, "expired");
  });

  it("sweepExpired does not touch non-expired or already-terminal sessions", () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const a = store.create({ workflow: "a", onFinalize });
    const b = store.create({ workflow: "b", onFinalize });
    store.setState(b.sessionId, "finalized");
    now += 16 * 60_000;
    const swept = store.sweepExpired();
    assert.equal(swept, 1);
    assert.equal(store.getById(a.sessionId)!.state, "expired");
    assert.equal(store.getById(b.sessionId)!.state, "finalized");
  });

  it("listAll returns all sessions sorted by createdAt DESC", () => {
    let now = 0;
    const store = createSessionStore({ now: () => now });
    now = 100;
    store.create({ workflow: "a", onFinalize });
    now = 200;
    store.create({ workflow: "b", onFinalize });
    now = 150;
    store.create({ workflow: "c", onFinalize });
    const all = store.listAll();
    assert.deepEqual(
      all.map((s) => s.workflow),
      ["b", "c", "a"],
    );
  });

  it("removePhoto by stable id removes the matching record (gaps OK)", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    const a = store.addPhoto(s.sessionId, photoInput("a.jpg", 100))!;
    const b = store.addPhoto(s.sessionId, photoInput("b.jpg", 200))!;
    const c = store.addPhoto(s.sessionId, photoInput("c.jpg", 300))!;
    assert.equal(a.index, 0);
    assert.equal(b.index, 1);
    assert.equal(c.index, 2);

    const removed = store.removePhoto(s.sessionId, b.index);
    assert.ok(removed);
    assert.equal(removed.filename, "b.jpg");
    const updated = store.getById(s.sessionId)!;
    assert.equal(updated.photos.length, 2);
    assert.deepEqual(
      updated.photos.map((p) => p.filename),
      ["a.jpg", "c.jpg"],
    );
    assert.deepEqual(
      updated.photos.map((p) => p.index),
      [0, 2],
    );

    // Next addPhoto picks up where the monotonic counter left off — the
    // freed index 1 stays vacant. This is the contract that lets the
    // photo-serving URL be stable across deletes.
    const d = store.addPhoto(s.sessionId, photoInput("d.jpg", 400))!;
    assert.equal(d.index, 3);
  });

  it("removePhoto returns undefined for unknown stable id", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    store.addPhoto(s.sessionId, photoInput("a.jpg"));
    assert.equal(store.removePhoto(s.sessionId, 99), undefined);
  });

  it("replacePhoto preserves the stable id and bumps uploadedAt", () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const s = store.create({ workflow: "x", onFinalize });
    const a = store.addPhoto(s.sessionId, photoInput("a.jpg", 100))!;

    now += 5_000;
    const result = store.replacePhoto(s.sessionId, a.index, {
      filename: "a-retake.jpg",
      sizeBytes: 150,
      mime: "image/jpeg",
      blurFlagged: true,
    });
    assert.ok(result);
    assert.equal(result.replaced.index, a.index);
    assert.equal(result.replaced.filename, "a-retake.jpg");
    assert.equal(result.replaced.sizeBytes, 150);
    assert.equal(result.replaced.uploadedAt, now);
    assert.equal(result.replaced.blurFlagged, true);
    assert.equal(result.old.filename, "a.jpg");
  });

  it("replacePhoto returns undefined for unknown stable id", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    const r = store.replacePhoto(s.sessionId, 99, photoInput("nope.jpg"));
    assert.equal(r, undefined);
  });

  it("reorderPhotos moves array positions but keeps stable ids attached", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    store.addPhoto(s.sessionId, photoInput("a.jpg"));
    store.addPhoto(s.sessionId, photoInput("b.jpg"));
    store.addPhoto(s.sessionId, photoInput("c.jpg"));

    const ok = store.reorderPhotos(s.sessionId, 0, 2);
    assert.equal(ok, true);
    const updated = store.getById(s.sessionId)!;
    assert.deepEqual(
      updated.photos.map((p) => p.filename),
      ["b.jpg", "c.jpg", "a.jpg"],
    );
    // Stable ids travel with the photos.
    assert.deepEqual(
      updated.photos.map((p) => p.index),
      [1, 2, 0],
    );
  });

  it("reorderPhotos rejects out-of-range positions", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    store.addPhoto(s.sessionId, photoInput("a.jpg"));
    assert.equal(store.reorderPhotos(s.sessionId, -1, 0), false);
    assert.equal(store.reorderPhotos(s.sessionId, 0, 9), false);
  });

  it("reorderPhotos no-ops when from === to", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    store.addPhoto(s.sessionId, photoInput("a.jpg"));
    store.addPhoto(s.sessionId, photoInput("b.jpg"));
    assert.equal(store.reorderPhotos(s.sessionId, 1, 1), true);
    assert.deepEqual(
      store.getById(s.sessionId)!.photos.map((p) => p.filename),
      ["a.jpg", "b.jpg"],
    );
  });

  it("extend bumps expiresAt by the requested delta", () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const s = store.create({ workflow: "x", onFinalize });
    const before = s.expiresAt;
    const result = store.extend(s.sessionId, 5 * 60_000);
    assert.equal(result, before + 5 * 60_000);
    assert.equal(store.getById(s.sessionId)!.expiresAt, before + 5 * 60_000);
  });

  it("extend rejects non-positive byMs", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    assert.equal(store.extend(s.sessionId, 0), undefined);
    assert.equal(store.extend(s.sessionId, -1), undefined);
  });

  it("markPhoneConnected stamps phoneConnectedAt and is idempotent", () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const s = store.create({ workflow: "x", onFinalize });
    assert.equal(
      store.markPhoneConnected(s.sessionId, { userAgent: "iPhone", ip: "10.0.0.5" }),
      true,
    );
    assert.equal(store.getById(s.sessionId)!.phoneConnectedAt, now);
    assert.equal(store.getById(s.sessionId)!.phoneUserAgent, "iPhone");
    assert.equal(store.getById(s.sessionId)!.phoneIp, "10.0.0.5");

    now += 100_000;
    // Idempotent — second call returns true but does NOT bump the timestamp.
    assert.equal(store.markPhoneConnected(s.sessionId), true);
    assert.equal(store.getById(s.sessionId)!.phoneConnectedAt, 1_000_000);
  });

  it("subscribe receives every emitted event; unsubscribe stops further fires", () => {
    const store = createSessionStore({ now: () => 0 });
    const events: CaptureSessionEvent[] = [];
    const unsub = store.subscribe((e) => events.push(e));

    const s = store.create({ workflow: "x", onFinalize });
    store.addPhoto(s.sessionId, photoInput("a.jpg"));
    store.markPhoneConnected(s.sessionId, { ip: "10.0.0.5" });
    store.setState(s.sessionId, "finalizing");

    const types = events.map((e) => e.type);
    assert.ok(types.includes("session_created"));
    assert.ok(types.includes("photo_added"));
    assert.ok(types.includes("phone_connected"));
    assert.ok(types.includes("finalize_requested"));

    unsub();
    const before = events.length;
    store.setState(s.sessionId, "finalized");
    assert.equal(events.length, before);
  });
});

describe("CaptureSession type", () => {
  it("conforms to expected shape", () => {
    const s: CaptureSession = {
      sessionId: "abc",
      token: "tok",
      workflow: "x",
      contextHint: undefined,
      createdAt: 1,
      expiresAt: 2,
      state: "open",
      photos: [],
      onFinalize: async (): Promise<void> => {},
    };
    assert.equal(s.workflow, "x");
  });
});
