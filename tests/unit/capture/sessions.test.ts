import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionStore,
  type CaptureSession,
} from "../../../src/capture/sessions.js";

const onFinalize = async (): Promise<void> => {};

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

  it("addPhoto appends to the session and bumps expiresAt", () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now });
    const s = store.create({ workflow: "x", onFinalize });
    now += 60_000;
    store.addPhoto(s.sessionId, { filename: "a.jpg", bytes: 100 });
    const updated = store.getById(s.sessionId)!;
    assert.equal(updated.photos.length, 1);
    assert.equal(updated.photos[0].filename, "a.jpg");
    assert.equal(updated.expiresAt, now + 15 * 60 * 1000);
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

  it("removePhoto by index removes and renumbers", () => {
    const store = createSessionStore({ now: () => 0 });
    const s = store.create({ workflow: "x", onFinalize });
    store.addPhoto(s.sessionId, { filename: "a.jpg", bytes: 100 });
    store.addPhoto(s.sessionId, { filename: "b.jpg", bytes: 200 });
    store.addPhoto(s.sessionId, { filename: "c.jpg", bytes: 300 });
    store.removePhoto(s.sessionId, 1);
    const updated = store.getById(s.sessionId)!;
    assert.equal(updated.photos.length, 2);
    assert.deepEqual(
      updated.photos.map((p) => p.filename),
      ["a.jpg", "c.jpg"],
    );
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
