import { afterEach, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";
import {
  captureRegistrations,
  makeCaptureFinalize,
} from "../../../src/tracker/dashboard/capture-state.js";
import type { CaptureSession } from "../../../src/services/capture/sessions.js";

let dir: string;
let previousPublicUrl: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hono-capture-"));
  previousPublicUrl = process.env.CAPTURE_PUBLIC_URL;
  process.env.CAPTURE_PUBLIC_URL = "http://127.0.0.1:3838";
});

afterEach(() => {
  if (previousPublicUrl === undefined) delete process.env.CAPTURE_PUBLIC_URL;
  else process.env.CAPTURE_PUBLIC_URL = previousPublicUrl;
  closeStateDbForTests(dir);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function app() {
  return createDashboardHonoApp({ dir, stateDb: openStateDb(dir), port: 3838 });
}

test("Hono capture start creates a manifest-visible session", async () => {
  const start = await app().request("/api/capture/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow: "oath-signature", contextHint: "paper oath" }),
  });
  assert.equal(start.status, 200);
  const startBody = await start.json() as { ok: boolean; token: string; captureUrl: string };
  assert.equal(startBody.ok, true);
  assert.match(startBody.captureUrl, /^http:\/\/127\.0\.0\.1:3838\/capture\//);

  const manifest = await app().request(`/api/capture/manifest/${startBody.token}`);
  assert.equal(manifest.status, 200);
  const manifestBody = await manifest.json() as { ok: boolean; workflow: string; contextHint?: string };
  assert.equal(manifestBody.ok, true);
  assert.equal(manifestBody.workflow, "oath-signature");
  assert.equal(manifestBody.contextHint, "paper oath");
});

test("Hono capture upload missing file returns 400", async () => {
  const start = await app().request("/api/capture/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow: "oath-signature" }),
  });
  const { token } = await start.json() as { token: string };
  const body = new FormData();
  const upload = await app().request(`/api/capture/upload?token=${token}`, { method: "POST", body });
  assert.equal(upload.status, 400);
  assert.deepEqual(await upload.json(), { ok: false, error: "missing 'file' part" });
});

test("Hono capture registry returns label + formType per entry", async () => {
  const res = await app().request("/api/capture/registry");
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, { label: string; formType: string }>;
  assert.equal(body["oath-signature"].label, "Capture paper roster");
  assert.equal(body["oath-signature"].formType, "oath");
  assert.equal(body["emergency-contact"].label, "Capture emergency contact forms");
  assert.equal(body["emergency-contact"].formType, "emergency-contact");
});

/** A minimal CaptureSession stub with a finalized PDF, for finalize tests. */
function fakeFinalizedSession(over: Partial<CaptureSession>): CaptureSession {
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    token: "tok",
    workflow: "oath-signature",
    createdAt: 0,
    expiresAt: 0,
    state: "finalizing",
    photos: [],
    pdfPath: "/tmp/fake.pdf",
    onFinalize: async () => {},
    ...over,
  } as CaptureSession;
}

/**
 * Captures the `formType` the prepare handler is invoked with, via the
 * `buildPrepareHandler` test seam — proving `makeCaptureFinalize` resolves it
 * from the declarative `captureRegistrations` entry (or `session.formType` for
 * `ocr`), NOT a hardcoded per-workflow branch.
 */
function finalizeAndCaptureFormType(session: CaptureSession): Promise<string | undefined> {
  let seen: string | undefined;
  const finalize = makeCaptureFinalize(dir, {
    buildPrepareHandler: () => async (input) => {
      seen = input.formType;
      return { status: 202, body: { ok: true, sessionId: input.sessionId ?? "", runId: "r" } };
    },
  });
  return finalize(session).then(() => seen);
}

test("makeCaptureFinalize resolves oath-signature formType from the registration", async () => {
  assert.equal(captureRegistrations["oath-signature"].formType, "oath");
  const seen = await finalizeAndCaptureFormType(fakeFinalizedSession({ workflow: "oath-signature" }));
  assert.equal(seen, "oath");
});

test("makeCaptureFinalize resolves emergency-contact formType from the registration", async () => {
  assert.equal(captureRegistrations["emergency-contact"].formType, "emergency-contact");
  const seen = await finalizeAndCaptureFormType(fakeFinalizedSession({ workflow: "emergency-contact" }));
  assert.equal(seen, "emergency-contact");
});

test("makeCaptureFinalize falls back to session.formType for an unregistered ocr workflow", async () => {
  assert.equal(captureRegistrations["ocr"], undefined);
  const seen = await finalizeAndCaptureFormType(
    fakeFinalizedSession({ workflow: "ocr", formType: "verify" }),
  );
  assert.equal(seen, "verify");
});

test("makeCaptureFinalize does not prepare when no formType can be resolved", async () => {
  let called = false;
  const finalize = makeCaptureFinalize(dir, {
    buildPrepareHandler: () => async (input) => {
      called = true;
      return { status: 202, body: { ok: true, sessionId: input.sessionId ?? "", runId: "r" } };
    },
  });
  await finalize(fakeFinalizedSession({ workflow: "not-registered" }));
  assert.equal(called, false);
});
