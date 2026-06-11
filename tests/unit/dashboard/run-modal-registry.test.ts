import { test } from "vitest";
import assert from "node:assert/strict";

import {
  getRunModalConfig,
  resolveTargetWorkflow,
  OCR_PREPARE_SUBMIT_URL,
} from "../../../src/dashboard/lib/run-modal-registry.js";

/**
 * `resolveTargetWorkflow` is the declarative replacement for the old
 * `submitUrl.endsWith("/api/ocr/prepare")` string-sniff that used to live in
 * the `RunModal` component. The component now just calls this; the
 * endpoint-string knowledge stays in the registry.
 */

test("resolveTargetWorkflow sends the target on the OCR-prepare submit path", () => {
  const config = getRunModalConfig("oath-signature");
  assert.ok(config);
  // A fresh upload (no reuploadFor) resolves submitUrl to the OCR-prep endpoint.
  assert.equal(config!.submitUrl({}), OCR_PREPARE_SUBMIT_URL);
  assert.equal(resolveTargetWorkflow(config!, {}), "oath-signature");
});

test("resolveTargetWorkflow suppresses the target on a reupload (non-prepare) path", () => {
  const config = getRunModalConfig("oath-signature");
  assert.ok(config);
  const ctx = { reuploadFor: { sessionId: "s1", previousRunId: "r1" } };
  // Reupload routes to /api/ocr/reupload — not the prepare endpoint.
  assert.notEqual(config!.submitUrl(ctx), OCR_PREPARE_SUBMIT_URL);
  assert.equal(resolveTargetWorkflow(config!, ctx), undefined);
});

test("resolveTargetWorkflow suppresses the target for oath-upload upload-only mode", () => {
  const config = getRunModalConfig("oath-upload");
  assert.ok(config);
  const ctx = { oathUploadMode: "upload-only" as const };
  // Upload-only posts straight to /api/oath-upload/start, and the entry's own
  // targetWorkflow resolver already returns undefined there.
  assert.notEqual(config!.submitUrl(ctx), OCR_PREPARE_SUBMIT_URL);
  assert.equal(resolveTargetWorkflow(config!, ctx), undefined);
});

test("resolveTargetWorkflow sends oath-upload as target in full mode", () => {
  const config = getRunModalConfig("oath-upload");
  assert.ok(config);
  const ctx = { oathUploadMode: "full" as const };
  assert.equal(config!.submitUrl(ctx), OCR_PREPARE_SUBMIT_URL);
  assert.equal(resolveTargetWorkflow(config!, ctx), "oath-upload");
});

test("resolveTargetWorkflow returns undefined for a standalone OCR run (no targetWorkflow declared)", () => {
  const config = getRunModalConfig("ocr");
  assert.ok(config);
  assert.equal(config!.submitUrl({}), OCR_PREPARE_SUBMIT_URL);
  // The `ocr` entry declares no targetWorkflow → no coordinator row.
  assert.equal(resolveTargetWorkflow(config!, {}), undefined);
});
