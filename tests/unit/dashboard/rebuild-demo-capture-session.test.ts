import { test } from "vitest";
import assert from "node:assert/strict";
import {
  CAPTURE_SESSIONS,
  captureSessionFor,
  captureSessionsFor,
  summarizeCaptureSession,
  type CaptureSessionFixture,
  type CaptureSessionPhase,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-runstart-wire.js";

/**
 * The capture panel's ONE derivation. Its phase and its blockers are computed
 * from what the server serves about a session rather than stamped beside it —
 * a stamped phase and a photo list can disagree, and the stamp is the one that
 * would be believed. The Run Modal's footer reads the same `blockers[0]` the
 * panel draws, so these also pin that the two cannot say different things.
 */

const byId = (id: string): CaptureSessionFixture => {
  const session = CAPTURE_SESSIONS.find((s) => s.id === id);
  assert.ok(session, `fixture ${id} is missing`);
  return session;
};

const phaseOf = (id: string): CaptureSessionPhase => summarizeCaptureSession(byId(id)).phase;

test("a session the phone never picked up is awaiting the phone, and is blocked", () => {
  const summary = summarizeCaptureSession(byId("cap-ec-4d52"));
  assert.equal(summary.phase, "awaiting-phone");
  assert.equal(summary.received, 0);
  assert.deepEqual(summary.blockers, ["No page has arrived yet."]);
  assert.equal(summary.lastArrivedAt, undefined);
});

test("a session still uploading is receiving, and may still be started", () => {
  const summary = summarizeCaptureSession(byId("cap-ec-9b04"));
  assert.equal(summary.phase, "receiving");
  assert.equal(summary.received, 3);
  assert.deepEqual(summary.blockers, []);
  assert.ok(summary.lastArrivedAt);
});

test("an unreadable page blocks the finalise and names itself", () => {
  const summary = summarizeCaptureSession(byId("cap-os-8b17"));
  assert.equal(summary.phase, "blocked");
  assert.equal(summary.unreadable, 1);
  assert.deepEqual(summary.blockers, ["Page 4 could not be read."]);
});

test("a finished session with nothing wrong is ready and blocks nothing", () => {
  const summary = summarizeCaptureSession(byId("cap-os-3f21"));
  assert.equal(summary.phase, "ready");
  assert.equal(summary.received, 8);
  assert.equal(summary.unreadable, 0);
  assert.deepEqual(summary.blockers, []);
});

test("a paired session with no page yet is awaiting pages, not awaiting the phone", () => {
  const paired: CaptureSessionFixture = { ...byId("cap-ec-4d52"), connectedAt: byId("cap-ec-4d52").openedAt };
  const summary = summarizeCaptureSession(paired);
  assert.equal(summary.phase, "awaiting-pages");
  assert.deepEqual(summary.blockers, ["No page has arrived yet."]);
});

test("every capture fixture is reachable from its workflow, and the default is the first", () => {
  assert.deepEqual(
    captureSessionsFor("oath-signature").map((s) => s.id),
    ["cap-os-3f21", "cap-os-8b17"],
  );
  assert.deepEqual(
    captureSessionsFor("emergency-contact").map((s) => s.id),
    ["cap-ec-9b04", "cap-ec-4d52"],
  );
  assert.equal(captureSessionFor("oath-signature")?.id, "cap-os-3f21");
  assert.equal(captureSessionFor("separations"), undefined);
});

test("the fixtures cover every phase the panel can draw", () => {
  const phases = new Set(CAPTURE_SESSIONS.map((s) => summarizeCaptureSession(s).phase));
  assert.ok(phases.has("awaiting-phone"));
  assert.ok(phases.has("receiving"));
  assert.ok(phases.has("blocked"));
  assert.ok(phases.has("ready"));
  // `awaiting-pages` has no fixture on purpose — a session the phone picked up
  // and then took nothing on is a blink, not a state worth a fixture. It is
  // derived and pinned above so the panel cannot draw the wrong one for it.
  assert.equal(phaseOf("cap-os-3f21"), "ready");
});

test("a page's served pixel size is the shape the placeholder is drawn at", () => {
  // The panel derives every frame's aspect ratio from these, so a page that
  // was never measured could never be drawn as US Letter by accident.
  for (const session of CAPTURE_SESSIONS) {
    for (const photo of session.photos) {
      assert.ok(photo.width > 0 && photo.height > 0, `${session.id} page ${photo.page} has no served size`);
      assert.equal(
        (photo.width / photo.height).toFixed(4),
        (612 / 792).toFixed(4),
        `${session.id} page ${photo.page} is not a US Letter page`,
      );
    }
  }
});
