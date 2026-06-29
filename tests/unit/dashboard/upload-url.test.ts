import { test } from "vitest";
import assert from "node:assert/strict";

import { resolveUploadBaseUrl } from "../../../src/dashboard/lib/upload-url.js";

/**
 * `resolveUploadBaseUrl` derives the dashboard's dedicated upload-listener
 * origin (mainPort + 1) from the page's `window.location`.
 *
 * Regression pin for ISS-001 (AI e2e run 20260629-0243): the upload port was
 * HARDCODED to :3839, so any non-default serving port misrouted every PDF
 * upload to :3839 — a DIFFERENT backend. The e2e harness serves the dashboard
 * on :3939 (upload listener :3940); the old hardcode sent its uploads to the
 * operator's real dashboard on :3839. The 3939 → :3940 case below is the exact
 * regression and FAILS against the old hardcoded `:3839`.
 */

test("prod default port 3838 → upload :3839 (unchanged)", () => {
  assert.equal(
    resolveUploadBaseUrl({ protocol: "http:", hostname: "localhost", port: "3838" }),
    "http://localhost:3839",
  );
});

test("vite dev port 5173 → upload :3839 (backend is the default :3838)", () => {
  assert.equal(
    resolveUploadBaseUrl({ protocol: "http:", hostname: "localhost", port: "5173" }),
    "http://localhost:3839",
  );
});

test("ISS-001: non-default e2e port 3939 → upload :3940 (no longer misrouted to :3839)", () => {
  assert.equal(
    resolveUploadBaseUrl({ protocol: "http:", hostname: "localhost", port: "3939" }),
    "http://localhost:3940",
  );
});

test("arbitrary non-default port derives port + 1", () => {
  assert.equal(
    resolveUploadBaseUrl({ protocol: "http:", hostname: "127.0.0.1", port: "8080" }),
    "http://127.0.0.1:8081",
  );
});

test("standard-port deployment (no explicit port) falls back to :3839", () => {
  assert.equal(
    resolveUploadBaseUrl({ protocol: "https:", hostname: "hr.example.edu", port: "" }),
    "https://hr.example.edu:3839",
  );
});
